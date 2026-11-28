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
import { IngestServiceUnreachable, newJobId } from "../ingest/client.ts";

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
  /**
   * Where a document ingest is remembered locally.
   *
   * Present only when uploads are: a document has to exist here before its ingest state
   * can point at it. Without it the route still starts jobs and records nothing, which is
   * the honest behaviour for a deployment that keeps no per-document state.
   */
  ingests?: DocumentIngestRecorder | undefined;
}

/**
 * The local record this route needs after an accepted start.
 *
 * Narrow on purpose: the route owns the request, the store owns the row, and neither has
 * to know the other's shape. Wider than the single call it exists for, it would become a
 * second place where "what an ingest state is" gets decided.
 */
export interface DocumentIngestRecorder {
  recordIngest(input: {
    documentId: string;
    stackId: string;
    userId: string;
    jobId: string | null;
    status: string;
  }): Promise<unknown>;
}

/**
 * The one state we can honestly write: we asked, and nothing here follows the job.
 *
 * No `ingested`, no `running`: those are observations the external service owns, and a
 * row claiming one would be a second, drifting source of truth - exactly what
 * `003_documents.sql` forbids reading `last_status` as.
 */
const REQUESTED_STATUS = "requested";

interface CreateJobBody {
  source?: unknown;
  documentId?: unknown;
  compile?: unknown;
  /** Which Stack the job belongs to, when it is not the endpoint's own. */
  stackId?: unknown;
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
): (
  | { kind: "source"; source: string; compile: boolean }
  | { kind: "document"; documentId: string; compile: boolean }
) & { stackId?: string | undefined } {
  const parsed = (body ?? {}) as CreateJobBody;
  // Anything other than an explicit `false` compiles, matching the upstream
  // default: omitting the field must not silently skip the compile.
  const compile = parsed.compile !== false;

  // A malformed Stack id is the SERVICE's to reject: it owns the UUID rule and the
  // error code a client branches on. Passing it through verbatim keeps one authority
  // instead of two that can drift.
  const stackId =
    typeof parsed.stackId === "string" && parsed.stackId.trim().length > 0
      ? parsed.stackId.trim()
      : undefined;

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
    return { kind: "document", documentId: (parsed.documentId as string).trim(), compile, stackId };
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
  return { kind: "source", source, compile, stackId };
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

    // Every 4xx is the CALLER's answer and travels untouched. Plus 503, which is the
    // service stating a fact about itself ("this host does not track jobs") rather
    // than failing on this call — folding it into 502 would hide a configuration
    // truth behind a transient-looking error.
    //
    // The rule rather than an enumeration is the point: a proxy that passes only the
    // codes someone thought of silently rewrites the next one the service adds. That
    // already happened here — 400 for a malformed Stack id was reported as 502,
    // turning a caller's typo into a deployment outage. 401, 429 or a future 4xx
    // would have gone the same way.
    if (upstream.status < 500 || upstream.status === 503) {
      // A `204` forbids a body by definition. `sendJson` would write `{}` with a
      // `content-length` for it, which is a payload nobody can read and a header that
      // lies to whatever proxy sits in front of this server.
      if (upstream.status === 204) {
        res.writeHead(204).end();
        return;
      }
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

    // Refuse a Stack that does not exist BEFORE creating the job.
    //
    // Not paranoia: the upstream accepts a well-formed unknown id with a `202` and
    // then writes no row, so the caller is handed a job id that can never be read -
    // and my own poll turns that into `404`, which reads as "your job vanished"
    // rather than "you named a Stack that is not there". Only a malformed id is
    // refused upstream, and only after the job exists.
    if (target.stackId !== undefined) {
      const known = await c.listStackIds();
      // `undefined` means the listing could not be read. Falling through to the
      // upstream's own validation is better than refusing a create because a
      // side-channel read failed.
      if (known !== undefined && !known.includes(target.stackId)) {
        throw new HttpError(
          400,
          "unknown_stack",
          `no Stack "${target.stackId}" exists. Ask the service for its Stacks and use one of those.`,
        );
      }
    }

    /**
     * Remember the request, but only once the service has ACCEPTED it.
     *
     * Three exclusions, each one a fact rather than a shortcut:
     *
     *  - A source-kind job has no document. This table is about uploads we hold; a URL
     *    or a path the service reads by itself has no row to point at.
     *  - A job with no Stack named has no identity here: the row's key is (document,
     *    Stack), and inventing a Stack would file a compile under a tenant nobody chose.
     *  - No recorder means this deployment keeps no per-document state at all.
     *
     * A failure to write propagates: better a caller who sees an error than an answer
     * that claims a state we could not store.
     */
    const recordAccepted = async (jobId: string): Promise<void> => {
      if (target.kind !== "document") return;
      const stackId = target.stackId;
      if (stackId === undefined) return;
      const recorder = deps.ingests;
      if (!recorder) return;
      await recorder.recordIngest({
        documentId: target.documentId,
        stackId,
        userId: ctx.userId,
        jobId,
        status: REQUESTED_STATUS,
      });
    };

    // A document reference has to become a URL before the service can read it, and
    // the resolver is the only part that knows storage. Refusing here keeps the
    // failure honest: without a public address there is no URL to hand over.
    let input: { source: string; compile: boolean; stackId?: string | undefined };
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
      input = { source: url, compile: target.compile, stackId: target.stackId };
    } else {
      input = { source: target.source, compile: target.compile, stackId: target.stackId };
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

    // Recorded BEFORE the answer and AFTER the upstream accepted, never earlier: a
    // refused start (`409 busy`, a 500, an unreachable host) must leave the table exactly
    // as it was, or the panel's mark and the retract precondition both start lying about
    // a job that never ran.
    //
    // The id is read with `newJobId` because the service names it `jobId` on the start
    // answer and `id` on a snapshot; pinning this path to one of the two would record
    // `undefined` the day the host changed shape.
    if (upstream.status >= 200 && upstream.status < 300) {
      const acceptedJobId = newJobId(upstream.body);
      if (acceptedJobId !== undefined) await recordAccepted(acceptedJobId);
    }

    if (upstream.status === 202) {
      sendJson(ctx.res, 202, upstream.body ?? {});
      return;
    }
    // Same rule as the reads, and it is what keeps `409 busy` a retry signal: the
    // one-ingest-at-a-time lock is an answer to the CALLER, not a service failure.
    if (upstream.status < 500 || upstream.status === 503) {
      sendJson(ctx.res, upstream.status, upstream.body ?? {});
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

  /**
   * Delete a liquidated job. The operator's cleanup, and the service's own answer.
   *
   * There is deliberately no cancel beside this: the service has none, and delete does
   * NOT stop a running job — it refuses with `409 job_still_working` and leaves the job
   * working. Routing a cancel through a delete would tell an operator their run stopped
   * while it kept writing.
   */
  router.delete("/ingest/jobs/:id", async (ctx) => {
    const id = ctx.params.id ?? "";
    if (id.trim() === "") throw new HttpError(404, "job_not_found", "no ingest job was named");
    await forward(ctx.res, (c) => c.deleteJob(id, stackIdFrom(ctx.url)));
  });

  /**
   * Re-execute a liquidated job. Answers a NEW job with a new id, so the caller polls the
   * id it gets back, not the one it sent.
   *
   * The body is forwarded untouched: the host names the new job `jobId` on one answer and
   * `id` on another, and `newJobId` in the adapter reads either. Rewriting the payload into
   * one shape here would bind every client to a shape the provider never promised. A
   * refusal travels verbatim as well, and is never retried by this server.
   */
  router.post("/ingest/jobs/:id/retry", async (ctx) => {
    const id = ctx.params.id ?? "";
    if (id.trim() === "") throw new HttpError(404, "job_not_found", "no ingest job was named");
    await forward(ctx.res, (c) => c.retryJob(id, stackIdFrom(ctx.url)));
  });

  // ---------------------------------------------------------------------------
  // Stacks
  // ---------------------------------------------------------------------------

  /**
   * The Stack ids this endpoint can reach, so a client can offer a choice.
   *
   * Read-only and additive: it publishes the SAME listing the create path already
   * validates against, and it reuses it rather than describing Stacks on its own. Ids
   * only — a name, a count or a page envelope would be a second source of truth about
   * a taxonomy this server does not own, and widening the body later binds a client.
   *
   * An unreadable listing answers `[]` with `200` instead of failing. `listStackIds()`
   * returns `undefined` when the host is down or answers something that is not a list,
   * and the create path already treats that as "fall through to the service's own
   * validation". An empty choice is a surface a client can recover from with a retry;
   * a `5xx` on a listing breaks an ingest form over a side-channel read.
   *
   * A host that cannot be REACHED, however, is a different fact and keeps the reads'
   * existing translation to `502`: it is a deployment fault, not an empty taxonomy.
   */
  router.get("/stacks", async (ctx) => {
    const c = requireClient();
    let known: string[] | undefined;
    try {
      known = await c.listStackIds();
    } catch (error) {
      // Same rule as `forward`, deliberately repeated in its shape rather than
      // generalised: `forward` passes an upstream body through unchanged, and this
      // route answers a body of its own.
      if (error instanceof IngestServiceUnreachable) {
        throw new HttpError(502, `ingest_service_${error.reason}`, error.message);
      }
      throw error;
    }
    // Non-array as well as `undefined`: a caller that trusts a shape it did not get
    // is the bug this guards, and an empty list states "nothing to offer" honestly.
    sendJson(ctx.res, 200, { stackIds: Array.isArray(known) ? known : [] });
  });
}
