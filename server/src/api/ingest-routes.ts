/**
 * @file src/api/ingest-routes.ts
 * @description Server-side proxy for an external ingest service's async jobs.
 *
 * ## Why the browser never talks to the service directly
 *
 * The service validates its own request headers, publishes no CORS headers and
 * answers no `OPTIONS` preflight, so a browser call from this product's origin
 * cannot succeed. Even where it could, it would expose the service to every client
 * that can reach it, and the service offers no credential of its own.
 *
 * So the browser talks to this server, which calls the service server-side: one
 * origin, the existing `CHAT_USERS` identity, and no new credential story.
 *
 * ## Status passthrough, because the codes carry different facts
 *
 * `404` means "this host tracks jobs and has never seen that id". `503` means
 * "this host does not track jobs at all". A UI that maps the second onto the first
 * stops polling a job that exists, so the codes are forwarded unchanged and the
 * web client is the only place that decides what they mean to a person.
 *
 * Anything else upstream (a `403` from a misconfigured bind, a `500`) becomes
 * `502` with the upstream status named, because those are deployment faults rather
 * than job states and must not be displayed as one.
 */

import type { Router } from "../http/router.ts";
import { HttpError, sendJson } from "../http/router.ts";
import type { IngestClient } from "../ingest/client.ts";
import { IngestServiceUnreachable } from "../ingest/client.ts";

/**
 * Turns an uploaded document into the reference the ingest service can read.
 *
 * Injected rather than imported so this route stays ignorant of storage, and so a
 * test can prove the URL-shape rule without a database.
 */
export interface DocumentResolver {
  /**
   * Resolve a document the caller owns into an absolute URL the service can fetch.
   *
   * `undefined` means "not this user's document", which is deliberately
   * indistinguishable from "no such document": a distinguishable answer would
   * confirm someone else's upload exists.
   */
  urlFor(documentId: string, userId: string): Promise<string | undefined>;
}

/**
 * The Stack a request names, taken from the query.
 *
 * Rails on the SERVER, not only in the browser: the service answers 404 for an
 * unknown Stack and 400 for a malformed one, and both are useful signals the client
 * shows directly. Reading the parameter here rather than forwarding a raw string
 * means the same value cannot be dropped silently between the two hops.
 */
function stackIdFrom(url: URL): string | undefined {
  const raw = url.searchParams.get("stackId")?.trim();
  return raw ? raw : undefined;
}

export interface IngestRouteDeps {
  /**
   * `undefined` when this deployment consumes no ingest service. The routes still
   * exist and answer 503 with a code that says so, which is more useful to the UI
   * than a 404 that looks like a missing feature.
   */
  ingest: IngestClient | undefined;
  /** `undefined` when this deployment cannot serve capability URLs. */
  documents: DocumentResolver | undefined;
}

interface CreateJobBody {
  source?: unknown;
  documentId?: unknown;
  compile?: unknown;
}

/**
 * Refuse before any upstream call: a blank source is a caller bug, not a job.
 *
 * Exactly one of `source` and `documentId` identifies the work. Both together are
 * refused rather than resolved by a precedence rule: whichever lost would be a
 * silent surprise at exactly the moment the operator thinks they specified it.
 */
function requireTarget(
  body: unknown,
): { kind: "source"; source: string; compile: boolean } | { kind: "document"; documentId: string; compile: boolean } {
  const parsed = (body ?? {}) as CreateJobBody;
  // Anything other than an explicit `false` compiles, matching the upstream
  // default: omitting the field must not silently skip the compile.
  const compile = parsed.compile !== false;

  const hasSource = typeof parsed.source === "string" && parsed.source.trim().length > 0;
  const hasDocument = typeof parsed.documentId === "string" && parsed.documentId.trim().length > 0;

  if (hasSource && hasDocument) {
    throw new HttpError(
      400,
      "ambiguous_target",
      "send either source or documentId, not both",
    );
  }
  if (hasDocument) {
    return { kind: "document", documentId: (parsed.documentId as string).trim(), compile };
  }
  if (!hasSource) {
    throw new HttpError(
      400,
      "invalid_source",
      "send documentId (an uploaded document) or source (a URL, or a path the service can read)",
    );
  }
  const source = parsed.source as string;
  if (source.length > 4096) {
    throw new HttpError(400, "invalid_source", "source is too long");
  }
  return { kind: "source", source, compile };
}

export function registerIngestRoutes(router: Router, deps: IngestRouteDeps): void {
  const client = deps.ingest;

  /** Shared precondition: no configured host is a deployment fact, not a missing job. */
  const requireClient = (): IngestClient => {
    if (!client) {
      throw new HttpError(
        503,
        "ingest_not_configured",
        "this deployment has no INGEST_API_BASE_URL, so it cannot read ingest jobs",
      );
    }
    return client;
  };

  /**
   * Forward an upstream read, preserving `200`, `404` and `503` exactly.
   *
   * `404` and `503` bodies are passed through as the host wrote them, so the code
   * a UI branches on (`job_not_found` vs `jobs_unavailable`) is the host's own
   * vocabulary rather than a translation this layer invented.
   */
  const forward = async (
    res: import("node:http").ServerResponse,
    call: (c: IngestClient) => Promise<{ status: number; body: unknown }>,
  ): Promise<void> => {
    const c = requireClient();
    let upstream: { status: number; body: unknown };
    try {
      upstream = await call(c);
    } catch (error) {
      if (error instanceof IngestServiceUnreachable) {
        // 502, not 503: the deployment IS configured, the host is just not
        // answering, and the two need different operator responses.
        throw new HttpError(502, `ingest_service_${error.reason}`, error.message);
      }
      throw error;
    }

    // 400 travels too: the service answers it for a MALFORMED stack id, which is a
    // caller mistake the UI must show as its own thing. Folding it into 502 would
    // report a validation error as a deployment failure and send an operator
    // looking at the wrong system.
    if (
      upstream.status === 200 ||
      upstream.status === 400 ||
      upstream.status === 404 ||
      upstream.status === 503
    ) {
      sendJson(res, upstream.status, upstream.body ?? {});
      return;
    }
    throw new HttpError(
      502,
      "ingest_service_error",
      // No recipe for how to run the other service: this product does not own that
      // knowledge, and a message that guesses at it becomes wrong the moment the
      // service moves. Name the fact and where the setting lives.
      `the ingest service answered ${upstream.status}` +
        (upstream.status === 403
          ? ": its request-header policy rejected this server. Check that " +
            "INGEST_API_BASE_URL names the address the service accepts."
          : ""),
    );
  };

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  /**
   * Start a job. Answers 202 with the service's own accepted body.
   *
   * `async` is forced by the client, never read from the caller: the synchronous
   * path blocks for minutes and there is no status surface to poll afterwards.
   */
  router.post("/ingest/jobs", async (ctx) => {
    const target = requireTarget(await ctx.body());
    const c = requireClient();

    // A document reference has to become a URL before the service can read it, and
    // the resolver is the only part that knows storage. Refusing here keeps the
    // failure honest: without a public address there is no URL to hand over.
    let input: { source: string; compile: boolean };
    if (target.kind === "document") {
      const resolver = deps.documents;
      if (!resolver) {
        throw new HttpError(
          503,
          "documents_not_configured",
          "this deployment has no PUBLIC_BASE_URL, so an uploaded document cannot be reached by the ingest service",
        );
      }
      const url = await resolver.urlFor(target.documentId, ctx.userId);
      if (!url) throw new HttpError(404, "not_found", "no such document");
      input = { source: url, compile: target.compile };
    } else {
      input = { source: target.source, compile: target.compile };
    }

    let upstream: { status: number; body: unknown };
    try {
      upstream = await c.createJob(input);
    } catch (error) {
      if (error instanceof IngestServiceUnreachable) {
        throw new HttpError(502, `ingest_service_${error.reason}`, error.message);
      }
      throw error;
    }

    if (upstream.status === 202) {
      sendJson(ctx.res, 202, upstream.body ?? {});
      return;
    }
    // `409 busy` is the one-ingest-at-a-time lock. It is a retry signal and must
    // reach the client as itself, not as a generic failure.
    if (upstream.status === 409) {
      sendJson(ctx.res, 409, upstream.body ?? { error: "busy" });
      return;
    }
    if (upstream.status === 400) {
      sendJson(ctx.res, 400, upstream.body ?? { error: "invalid_source" });
      return;
    }
    if (upstream.status === 503) {
      sendJson(ctx.res, 503, upstream.body ?? { error: "jobs_unavailable" });
      return;
    }
    throw new HttpError(502, "ingest_service_error", `the ingest service answered ${upstream.status}`);
  });

  /** One job snapshot. The poller's only read. */
  router.get("/ingest/jobs/:id", async (ctx) => {
    const id = ctx.params.id ?? "";
    if (id.trim() === "") throw new HttpError(404, "job_not_found", "no ingest job was named");
    await forward(ctx.res, (c) => c.getJob(id, stackIdFrom(ctx.url)));
  });

  /** Every retained job, newest first, exactly as the host orders them. */
  router.get("/ingest/jobs", async (ctx) => {
    await forward(ctx.res, (c) => c.listJobs(stackIdFrom(ctx.url)));
  });
}
