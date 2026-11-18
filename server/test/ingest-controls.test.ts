import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { IngestClient, newJobId } from "../src/ingest/client.ts";
import { registerIngestRoutes } from "../src/api/ingest-routes.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";

/**
 * WHAT THESE TESTS PIN, AND WHY EACH ONE EXISTS
 *
 * `odd/tasks/ingest-operator-controls.md` adds two operator controls over the external
 * ingest service: delete a liquidated job, and retry it. Both are the SERVICE's own
 * operations, so the failure modes are not "the JSON shape is wrong". They are:
 *
 *   1. We invent an operation the service does not have, or claim a working job can be
 *      interrupted. It cannot: delete refuses with `409 job_still_working` and does NOT
 *      stop the job, so a UI that showed a cancel would be lying to an operator about
 *      what happened to their data.
 *   2. We translate the service's refusals. `404 job_not_found`, `409 job_still_working`
 *      and `409 job_changed` are the host's vocabulary for "you may clean this up" and
 *      "you may re-execute this"; folding any of them into `502` turns an operator's
 *      answer into a deployment outage, and a client that retried on `502` would retry
 *      the one thing the host just refused.
 *   3. We drop the Stack at the proxy. Every ingest call names the Stack in the query, and
 *      a dropped parameter silently retargets the control at the endpoint's bound Stack.
 *      An assertion on the response cannot see that; only the SENT query can.
 *   4. We send `?stackId=` for a Stack that is absent. An empty parameter names a Stack
 *      called `""`, so absence has to stay absent.
 *   5. We reshape the retry payload. The new job id arrives as `jobId` on one answer and
 *      `id` on another; re-emitting a normalized body would bind a client to a shape this
 *      server invented, so the body travels byte for byte and reading the id is tolerant.
 *
 * The fake host below answers exactly the two paths the feature names and records every
 * request, so a passing test proves what the proxy SENT, not merely what it returned.
 */

const USER = "test-user";
const TOKEN = "test-token-value-1234";

const DELETE_PATH = /^\/api\/ingest\/jobs\/[^/]+$/;
const RETRY_PATH = /^\/api\/ingest\/jobs\/[^/]+\/retry$/;

interface SeenRequest {
  method: string;
  path: string;
  search: URLSearchParams;
  /** The stackId the proxy actually sent, or null when it sent no parameter at all. */
  stackId: string | null;
}

/**
 * A stand-in for the ingest service's two operator routes.
 *
 * Deliberately answer-only-what-was-specified: anything the real service does not
 * implement (a cancel, a body on a retry) answers 404 here too, so a test that passed
 * against a more forgiving fake could not exist.
 */
class ControlsHost {
  readonly seen: SeenRequest[] = [];
  server!: Server;
  port = 0;
  /** The literal answer the next control request receives. */
  next: { status: number; text: string } = { status: 200, text: "{}" };

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);

      const url = new URL(req.url ?? "/", "http://placeholder");
      const method = req.method ?? "GET";
      this.seen.push({
        method,
        path: url.pathname,
        search: url.searchParams,
        stackId: url.searchParams.get("stackId"),
      });

      const isControl =
        (method === "DELETE" && DELETE_PATH.test(url.pathname)) ||
        (method === "POST" && RETRY_PATH.test(url.pathname));

      if (isControl) {
        // A 204 forbids a body, so the fake must not write one either: a test about a
        // body-less success is only meaningful if the upstream actually sent none.
        if (this.next.status === 204) {
          res.writeHead(204).end();
          return;
        }
        res.writeHead(this.next.status, { "content-type": "application/json" });
        res.end(this.next.text);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "no such route" } }));
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  /** The request at `index` counted from the moment this was called. */
  at(index: number): SeenRequest | undefined {
    return this.seen[index];
  }
}

describe("reading the job id a retry minted", () => {
  // The SERVICE decides which key it answers with, so the reader accepts both and never
  // rewrites the payload it read them from. A single-armed reader is the defect this
  // covers: it would read `{jobId}` today and go blind the day the host answers `{id}`.
  test("reads jobId first, then id", () => {
    assert.equal(newJobId({ jobId: "ing_new" }), "ing_new");
    assert.equal(newJobId({ id: "ing_new" }), "ing_new");
    // Both present: `jobId` is the documented one, `id` the fallback.
    assert.equal(newJobId({ jobId: "ing_a", id: "ing_b" }), "ing_a");
  });

  test("is absent for a body that names no job, instead of inventing one", () => {
    assert.equal(newJobId({}), undefined);
    assert.equal(newJobId(undefined), undefined);
    assert.equal(newJobId(null), undefined);
    assert.equal(newJobId("ing_new"), undefined);
    // Non-strings are not ids: `{}` or `42` would be shown as a job nobody can poll.
    assert.equal(newJobId({ jobId: 42 }), undefined);
    assert.equal(newJobId({ id: { nested: "ing_new" } }), undefined);
    // Blank is the absence of an id, not an id that happens to be empty.
    assert.equal(newJobId({ jobId: "   " }), undefined);
    assert.equal(newJobId({ jobId: "  ing_padded  " }), "ing_padded");
  });
});

describe("the operator control routes", () => {
  const host = new ControlsHost();
  let server: Server;
  let baseUrl: string;

  const startProxy = async (configured: boolean): Promise<{ server: Server; baseUrl: string }> => {
    const router = createRouter({
      authenticate: createAuthenticator({ users: `${USER}:${TOKEN}` }),
    });
    registerIngestRoutes(router, {
      ingest: configured
        ? new IngestClient({ baseUrl: host.baseUrl, timeoutMs: 2000 })
        : undefined,
      documents: undefined,
    });
    const started = await router.listen(0, "127.0.0.1");
    return {
      server: started,
      baseUrl: `http://127.0.0.1:${(started.address() as AddressInfo).port}`,
    };
  };

  const headers = { "x-dev-token": TOKEN, "x-user-id": USER };

  /** One call through the proxy, answering with the raw body so bytes can be compared. */
  const call = async (
    path: string,
    init: { method: string; headers?: Record<string, string> },
  ): Promise<{ status: number; text: string; body: unknown; headers: Headers }> => {
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers: init.headers ?? headers });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: text === "" ? undefined : JSON.parse(text),
      headers: res.headers,
    };
  };

  before(async () => {
    await host.start();
    const started = await startProxy(true);
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    server?.close();
    await host.close();
  });

  // ---------------------------------------------------------------------------
  // Where the request actually goes
  // ---------------------------------------------------------------------------

  test("DELETE reaches the service's own job path, with no stackId when none was named", async () => {
    const before = host.seen.length;
    const res = await call("/ingest/jobs/ing_1", { method: "DELETE" });

    assert.equal(res.status, 200);
    const seen = host.at(before);
    assert.equal(seen?.method, "DELETE", "the verb is the service's, not a POST with a flag");
    assert.equal(seen?.path, "/api/ingest/jobs/ing_1");
    // An empty `?stackId=` would name a Stack called ""; absence is the statement.
    assert.equal(seen?.stackId, null);
    assert.doesNotMatch(formatQuery(seen), /stackId/);
  });

  test("DELETE carries the link's Stack in the query", async () => {
    const stackId = "aaaaaaaa-1111-2222-3333-444444444444";
    const before = host.seen.length;
    await call(`/ingest/jobs/ing_2?stackId=${stackId}`, { method: "DELETE" });
    const seen = host.at(before);
    assert.equal(seen?.path, "/api/ingest/jobs/ing_2");
    // Asserted on the SENT query: a dropped parameter looks identical in the response.
    assert.equal(seen?.stackId, stackId);
  });

  test("POST retry reaches the service's retry path, with and without a Stack", async () => {
    const stackId = "bbbbbbbb-1111-2222-3333-444444444444";

    const withStack = host.seen.length;
    await call(`/ingest/jobs/ing_3/retry?stackId=${stackId}`, { method: "POST" });
    assert.equal(host.at(withStack)?.method, "POST");
    assert.equal(host.at(withStack)?.path, "/api/ingest/jobs/ing_3/retry");
    assert.equal(host.at(withStack)?.stackId, stackId);

    const without = host.seen.length;
    await call("/ingest/jobs/ing_4/retry", { method: "POST" });
    assert.equal(host.at(without)?.path, "/api/ingest/jobs/ing_4/retry");
    assert.equal(host.at(without)?.stackId, null);
    assert.doesNotMatch(formatQuery(host.at(without)), /stackId/);
  });

  test("the job id is encoded, so a hostile id cannot address another route", async () => {
    const before = host.seen.length;
    await call(`/ingest/jobs/${encodeURIComponent("a b")}`, { method: "DELETE" });
    // The service receives the id as one path segment, escaped on the way out.
    assert.equal(host.at(before)?.path, "/api/ingest/jobs/a%20b");
  });

  // ---------------------------------------------------------------------------
  // Success
  // ---------------------------------------------------------------------------

  test("DELETE forwards a 200 body verbatim", async () => {
    host.next = { status: 200, text: '{"deleted":true,"jobId":"ing_5"}' };
    const res = await call("/ingest/jobs/ing_5", { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { deleted: true, jobId: "ing_5" });
  });

  test("DELETE answers 204 with no body and no length for one", async () => {
    host.next = { status: 204, text: "" };
    const res = await call("/ingest/jobs/ing_6", { method: "DELETE" });
    assert.equal(res.status, 204);
    assert.equal(res.text, "");
    // A 204 forbids a body, and a generic JSON sender writes `{}` for it and declares
    // `content-length: 2`. Node drops the bytes for a 204, so the lie survives as a
    // header that a stricter proxy in front of this server cannot reconcile — which is
    // exactly the kind of damage a status-only assertion cannot see.
    assert.equal(res.headers.get("content-length"), null);
  });

  test("retry forwards a 202 unchanged, whichever key names the new job", async () => {
    host.next = {
      status: 202,
      text: '{"jobId":"ing_new","status":"queued","ingest":{"status":"queued"},"compile":{"status":"queued"}}',
    };
    const res = await call("/ingest/jobs/ing_7/retry", { method: "POST" });
    assert.equal(res.status, 202);
    // Byte for byte: the retry mints a NEW job and the caller needs that job's own
    // snapshot, not a body this proxy normalized into something it can recognize.
    assert.equal(res.text, host.next.text);
    assert.equal(newJobId(res.body), "ing_new");

    host.next = { status: 200, text: '{"id":"ing_other","status":"queued"}' };
    const second = await call("/ingest/jobs/ing_8/retry", { method: "POST" });
    assert.equal(second.status, 200);
    assert.equal(second.text, host.next.text, "the alternative key shape travels as written");
    assert.equal(newJobId(second.body), "ing_other");
  });

  // ---------------------------------------------------------------------------
  // Refusals: the host's vocabulary, not ours
  // ---------------------------------------------------------------------------

  const refusals: Array<{ status: number; code: string; detail: string }> = [
    { status: 404, code: "job_not_found", detail: "no ingest job 'ing_x'" },
    { status: 409, code: "job_still_working", detail: "job 'ing_x' is working; delete does not interrupt it" },
    { status: 409, code: "job_changed", detail: "job 'ing_x' changed after it was read" },
  ];

  for (const refusal of refusals) {
    test(`${refusal.status} ${refusal.code} reaches the client unchanged, never as 502`, async () => {
      const text = JSON.stringify({ error: { code: refusal.code, message: refusal.detail } });
      host.next = { status: refusal.status, text };

      for (const [path, method] of [
        ["/ingest/jobs/ing_x", "DELETE"],
        ["/ingest/jobs/ing_x/retry", "POST"],
      ] as const) {
        const res = await call(path, { method });
        assert.equal(res.status, refusal.status, `${method} ${path} must keep the host's status`);
        // Byte for byte, and it is the body that carries the code a client branches on:
        // `job_still_working` is "wait", `job_changed` is "re-read and decide again".
        assert.equal(res.text, text, `${method} ${path} must keep the host's body`);
        assert.notEqual(res.body && (res.body as { error?: string }).error, "ingest_service_error");
      }
    });
  }

  test("an upstream 500 is the service failing at this call, so it becomes 502", async () => {
    // The other half of the rule, and the reason it is a rule rather than a list: only
    // a 5xx other than 503 is this server's own failure to report as such.
    host.next = { status: 500, text: '{"error":{"code":"internal_error","message":"boom"}}' };
    for (const [path, method] of [
      ["/ingest/jobs/ing_x", "DELETE"],
      ["/ingest/jobs/ing_x/retry", "POST"],
    ] as const) {
      const res = await call(path, { method });
      assert.equal(res.status, 502);
      assert.equal((res.body as { error?: string }).error, "ingest_service_error");
    }
  });

  test("the refusals are not retried: one call, one attempt", async () => {
    // A 409 is the host REFUSING this operation. Repeating it would be the proxy doing
    // the one thing the host just said no to, and it would show an operator a result
    // from a call they cannot see.
    host.next = {
      status: 409,
      text: '{"error":{"code":"job_still_working","message":"still working"}}',
    };
    const before = host.seen.length;
    await call("/ingest/jobs/ing_x", { method: "DELETE" });
    assert.equal(host.seen.length - before, 1);
  });

  // ---------------------------------------------------------------------------
  // Refusals that are not the host's at all
  // ---------------------------------------------------------------------------

  test("a blank id is refused before any upstream call", async () => {
    // Same precondition as the read route: an id of whitespace names no job, and asking
    // the host about it only teaches the caller that the host was slow.
    const before = host.seen.length;
    for (const [path, method] of [
      ["/ingest/jobs/%20", "DELETE"],
      ["/ingest/jobs/%20/retry", "POST"],
    ] as const) {
      const res = await call(path, { method });
      assert.equal(res.status, 404);
      assert.equal((res.body as { error?: string }).error, "job_not_found");
    }
    assert.equal(host.seen.length, before, "no upstream request may be made for a blank id");
  });

  test("there is no cancel, at any layer", async () => {
    // The service has no cancel operation and delete does not interrupt a running job,
    // so a cancel route would be this server promising something nobody can do. Pinned
    // as a test because "we did not add it" is otherwise only a claim about a diff.
    const before = host.seen.length;
    for (const [path, method] of [
      ["/ingest/jobs/ing_x/cancel", "POST"],
      ["/ingest/jobs/ing_x/cancel", "DELETE"],
      // Neither is a renamed cancel: the only mutation of a job here is the delete.
      ["/ingest/jobs/ing_x", "PATCH"],
    ] as const) {
      const res = await fetch(`${baseUrl}${path}`, { method, headers });
      assert.equal(res.status, 404, `${method} ${path} must not exist`);
    }
    assert.equal(host.seen.length, before, "a nonexistent operation reaches no service");
  });

  test("both routes need identity like the routes beside them", async () => {
    const before = host.seen.length;
    for (const [path, method] of [
      ["/ingest/jobs/ing_x", "DELETE"],
      ["/ingest/jobs/ing_x/retry", "POST"],
    ] as const) {
      const res = await fetch(`${baseUrl}${path}`, { method });
      assert.equal(res.status, 401);
    }
    assert.equal(host.seen.length, before, "an unauthenticated control never reaches the service");
  });

  test("an unconfigured deployment answers 503 with its own code, not a fake 404", async () => {
    const unconfigured = await startProxy(false);
    try {
      for (const [path, method] of [
        ["/ingest/jobs/ing_x", "DELETE"],
        ["/ingest/jobs/ing_x/retry", "POST"],
      ] as const) {
        const res = await fetch(`${unconfigured.baseUrl}${path}`, { method, headers });
        assert.equal(res.status, 503);
        const body = (await res.json()) as { error?: string };
        assert.equal(body.error, "ingest_not_configured");
      }
    } finally {
      unconfigured.server.close();
    }
  });
});

describe("an unreachable host is a deployment fact, not a job state", () => {
  const headers = { "x-dev-token": TOKEN, "x-user-id": USER };

  const startProxy = async (upstreamBaseUrl: string, timeoutMs?: number) => {
    const router = createRouter({
      authenticate: createAuthenticator({ users: `${USER}:${TOKEN}` }),
    });
    registerIngestRoutes(router, {
      ingest: new IngestClient({
        baseUrl: upstreamBaseUrl,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
      documents: undefined,
    });
    const started = await router.listen(0, "127.0.0.1");
    return {
      server: started,
      baseUrl: `http://127.0.0.1:${(started.address() as AddressInfo).port}`,
    };
  };

  test("a refused connection answers 502 ingest_service_network on both routes", async () => {
    // Port 1 on loopback: the deployment IS configured, nothing is listening.
    const proxy = await startProxy("http://127.0.0.1:1", 500);
    try {
      for (const [path, method] of [
        ["/ingest/jobs/ing_x", "DELETE"],
        ["/ingest/jobs/ing_x/retry", "POST"],
      ] as const) {
        const res = await fetch(`${proxy.baseUrl}${path}`, { method, headers });
        assert.equal(res.status, 502);
        const body = (await res.json()) as { error?: string };
        assert.equal(body.error, "ingest_service_network");
      }
    } finally {
      proxy.server.close();
    }
  });

  test("a host that accepts connections but never answers times out as 502 ingest_service_timeout", async () => {
    const silent = createServer(() => {
      // Deliberately never responds.
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as AddressInfo).port;
    const proxy = await startProxy(`http://127.0.0.1:${port}`, 200);
    try {
      for (const [path, method] of [
        ["/ingest/jobs/ing_x", "DELETE"],
        ["/ingest/jobs/ing_x/retry", "POST"],
      ] as const) {
        const res = await fetch(`${proxy.baseUrl}${path}`, { method, headers });
        assert.equal(res.status, 502);
        const body = (await res.json()) as { error?: string };
        assert.equal(body.error, "ingest_service_timeout");
      }
    } finally {
      proxy.server.close();
      silent.closeAllConnections?.();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

/** The query string a recorded request carried, as one comparable string. */
function formatQuery(seen: SeenRequest | undefined): string {
  if (!seen) return "";
  return [...seen.search.entries()].map(([key, value]) => `${key}=${value}`).join("&");
}
