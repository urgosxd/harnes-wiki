/**
 * @file src/ingest/client.ts
 * @description HTTP adapter for an external ingest service: start a job, read it, and
 * run the operator's two controls over it (delete a liquidated one, retry it).
 *
 * ## This file knows the PROTOCOL, not the provider
 *
 * The service behind this adapter lives in another repository and is deployed
 * separately. Nothing here encodes how it is built, started, bound or migrated:
 * that knowledge belongs to whoever operates it. If it moves, changes its address,
 * or is replaced by another implementation of the same protocol, the fix is
 * configuration — `INGEST_API_BASE_URL` — and this file does not change.
 *
 * What it does encode is the wire contract, because a client cannot be ignorant of
 * the protocol it speaks: two independent dimensions, real stage names, no
 * percentage, and `404` ≠ `503`.
 *
 * ## Two rules about headers that are not negotiable
 *
 * The service rejects a request whose `Host` is not the address it bound, and
 * rejects a foreign `Origin`. It publishes no CORS headers and answers no
 * preflight. Both follow from one decision: this adapter is server-side only.
 *
 *  1. **Never forward the browser's `Host`.** The browser talks to this product,
 *     so its `Host` names this product. Node derives `Host` from the request URL
 *     and ignores an explicit one, which happens to make the correct construction
 *     the only possible one: build the URL from the configured origin and send no
 *     `Host` of our own.
 *  2. **Never forward the browser's `Origin`.** It would name this product's
 *     origin and fail the service's same-origin check. This adapter sends no
 *     `Origin` at all.
 *
 * ## What it does NOT do
 *
 * It does not reshape the payload. Every field (`ingest.status`, `ingest.stage`,
 * `ingest.attempts`, `compile.status`, `compile.stage`, `compile.progress`) is
 * forwarded byte for byte. A proxy that "normalizes" the two dimensions is exactly
 * how a UI starts inventing state the pipeline never reported.
 */

/** An upstream answer, whether or not it was a success. */
export interface UpstreamResponse {
  /** Status the upstream answered with, preserved so 404 and 503 stay distinct. */
  status: number;
  /** Parsed JSON body, or `undefined` when the body was not JSON. */
  body: unknown;
}

/** The upstream could not be reached at all, which is NOT one of its HTTP answers. */
export class IngestServiceUnreachable extends Error {
  readonly reason: "timeout" | "network";

  constructor(reason: "timeout" | "network", message: string) {
    super(message);
    this.reason = reason;
  }
}

/** One job as accepted by the async start endpoint. */
export interface AcceptedJob {
  jobId: string;
  status: string;
  stage: string;
  ingest: unknown;
  compile: unknown;
}

export interface IngestClientOptions {
  /** Origin of the service, e.g. `http://host:4173`. Never a path. */
  baseUrl: string;
  /**
   * Read timeout in milliseconds. Job reads are snapshots and return immediately;
   * a slow one means the service is wedged, and a poller must learn that quickly
   * rather than hanging behind a socket that will never answer.
   */
  timeoutMs?: number;
  /** Injection seam for tests. */
  fetchImpl?: typeof fetch;
}

export class IngestClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(options: IngestClientOptions) {
    // Trailing slashes would produce `//ingest/...`; the origin is the whole address.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.doFetch = options.fetchImpl ?? fetch.bind(globalThis);
  }

  /**
   * Start an asynchronous ingest.
   *
   * The async flag is FORCED, not forwarded from the caller. Without it the
   * endpoint runs the whole pipeline inside the response and blocks for minutes,
   * which is the failure this feature removes; a caller that forgot the flag would
   * turn a status screen into a hung request. The compile choice is honoured,
   * because that is a real decision.
   *
   * @param input - Source identity, resolved on the SERVICE's filesystem, and
   *   whether to compile afterwards.
   */
  async createJob(input: {
    source: string;
    compile: boolean;
    stackId?: string | undefined;
  }): Promise<UpstreamResponse> {
    // `stackId` travels in the QUERY, matching the read routes, so a caller always
    // names the Stack in the same place regardless of the verb.
    return this.request("POST", `/api/ingest${stackQuery(input.stackId)}`, {
      source: input.source,
      async: true,
      compile: input.compile,
    });
  }

  /**
   * The Stack ids this endpoint can reach.
   *
   * A plain read of the service's own `/stacks` listing: it costs one request and
   * needs no MCP session, which is why it is usable on a request path where opening
   * a second protocol connection would be out of proportion. A failure here is
   * deliberately NOT fatal - if the listing cannot be read, callers fall back to the
   * upstream's own validation rather than refusing every create.
   */
  async listStackIds(): Promise<string[] | undefined> {
    const response = await this.request("GET", "/stacks");
    if (response.status !== 200 || !Array.isArray(response.body)) return undefined;
    return (response.body as Array<{ id?: unknown }>)
      .map((entry) => (typeof entry?.id === "string" ? entry.id : undefined))
      .filter((id): id is string => id !== undefined);
  }

  /** Read one job snapshot. 404 (unknown id) and 503 (no tracking) are distinct. */
  async getJob(id: string, stackId?: string): Promise<UpstreamResponse> {
    return this.request("GET", `/api/ingest/jobs/${encodeURIComponent(id)}${stackQuery(stackId)}`);
  }

  /** Read every retained job, newest first, as the service orders them. */
  async listJobs(stackId?: string): Promise<UpstreamResponse> {
    return this.request("GET", `/api/ingest/jobs${stackQuery(stackId)}`);
  }

  /**
   * Delete a liquidated job row.
   *
   * Only the SERVICE decides whether a row may be cleaned up, and its refusals are
   * different facts rather than one failure: `409 job_still_working` says the job is
   * running and that this call does NOT interrupt it, `409 job_changed` says the row
   * moved since it was read, `404 job_not_found` says this host never had it. All three
   * travel to the caller unchanged, and none of them is retried here: repeating the
   * operation the host just refused is not a recovery, it is the same refusal again.
   */
  async deleteJob(id: string, stackId?: string): Promise<UpstreamResponse> {
    return this.request("DELETE", `/api/ingest/jobs/${encodeURIComponent(id)}${stackQuery(stackId)}`);
  }

  /**
   * Re-execute a liquidated job as a NEW job, minted by the service (`ing_${ulid()}`).
   *
   * The original row is untouched, so a caller must follow the id it gets BACK rather
   * than the one it sent; `newJobId` below reads it from whichever key the host used.
   * Both operations share the host's one guard — a row can be re-executed exactly when
   * it can be cleaned up — which is why a working job is refused here as well.
   */
  async retryJob(id: string, stackId?: string): Promise<UpstreamResponse> {
    return this.request(
      "POST",
      `/api/ingest/jobs/${encodeURIComponent(id)}/retry${stackQuery(stackId)}`,
    );
  }

  private async request(method: string, path: string, body?: unknown): Promise<UpstreamResponse> {
    // The URL is the ONLY source of the Host header. Nothing from the incoming
    // browser request is consulted here: no Host, no Origin, no cookies.
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // A timeout and a refused connection are different operator problems, so
      // they are reported differently instead of collapsing into "it failed".
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new IngestServiceUnreachable(
          "timeout",
          `the ingest service did not answer within ${this.timeoutMs}ms at ${this.baseUrl}`,
        );
      }
      throw new IngestServiceUnreachable(
        "network",
        `cannot reach the ingest service at ${this.baseUrl}: ${messageOf(error)}`,
      );
    }

    return { status: response.status, body: await parseBody(response) };
  }
}

/**
 * The id of the job a retry minted, read from the payload the service answered with.
 *
 * Two keys appear in the wild: `jobId`, which the start route already answers with, and
 * `id`, which is what a job snapshot calls the same value. Reading both is the point —
 * a reader pinned to one shape eventually polls `undefined`, and the failure shows up as
 * a spinner rather than as an error. The payload is only READ: the retry route forwards
 * it byte for byte, because a body this adapter rewrote would bind every client to a
 * shape the provider never promised.
 *
 * Blank counts as absent: an id of whitespace names no job anyone can read.
 */
export function newJobId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as { jobId?: unknown; id?: unknown };
  for (const candidate of [record.jobId, record.id]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * The `?stackId=` suffix, or nothing.
 *
 * Absent must stay absent rather than becoming an empty parameter: an empty value
 * would be sent as a Stack named `""`, and the service would have to guess whether
 * that means "the bound one" or "a Stack with no id".
 */
function stackQuery(stackId: string | undefined): string {
  const trimmed = stackId?.trim();
  return trimmed ? `?stackId=${encodeURIComponent(trimmed)}` : "";
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A non-JSON body is still an answer (a proxy error page, for instance). Keep
    // the text so the caller can show something truer than "unknown error".
    return { error: { code: "invalid_upstream_body", message: text.slice(0, 500) } };
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // `fetch failed` hides the real cause, which is the only actionable part.
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) return `${error.message} (${cause.message})`;
    return error.message;
  }
  return String(error);
}
