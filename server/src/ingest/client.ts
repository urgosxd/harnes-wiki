/**
 * @file src/ingest/client.ts
 * @description HTTP adapter for an external ingest service: start a job, read it.
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
  async createJob(input: { source: string; compile: boolean }): Promise<UpstreamResponse> {
    return this.request("POST", "/api/ingest", {
      source: input.source,
      async: true,
      compile: input.compile,
    });
  }

  /** Read one job snapshot. 404 (unknown id) and 503 (no tracking) are distinct. */
  async getJob(id: string, stackId?: string): Promise<UpstreamResponse> {
    return this.request("GET", `/api/ingest/jobs/${encodeURIComponent(id)}${stackQuery(stackId)}`);
  }

  /** Read every retained job, newest first, as the service orders them. */
  async listJobs(stackId?: string): Promise<UpstreamResponse> {
    return this.request("GET", `/api/ingest/jobs${stackQuery(stackId)}`);
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
