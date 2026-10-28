import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig, parseExternalApiConfig, ConfigError } from "../src/config.ts";
import { IngestClient, IngestServiceUnreachable } from "../src/ingest/client.ts";
import { registerIngestRoutes } from "../src/api/ingest-routes.ts";
import { createRouter, type Router } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";

/**
 * WHAT THESE TESTS PIN, AND WHY EACH ONE EXISTS
 *
 * The integration's failure modes are not "the JSON shape is wrong". They are:
 *
 *   1. We send a `Host`/`Origin` the service rejects, so every request is a 403 and
 *      the UI shows a permanent error that looks like a job problem.
 *   2. We collapse `404` (unknown job) into `503` (host does not track jobs), so a
 *      poller stops on a job that exists.
 *   3. We forward the browser's `Host` or `Origin`, which is the same defect as
 *      (1) but arrives through the proxy instead of the configuration.
 *   4. We accept the synchronous default and block for minutes.
 *
 * The fake host below implements the real origin policy (exact `Host` match plus
 * `localhost` on loopback, and same-origin `Origin` when present) so a test that
 * passes proves the client would be accepted by the real thing, not merely that
 * our own stub agreed with us.
 */

const USER = "test-user";
const TOKEN = "test-token-value-1234";

interface SeenRequest {
  method: string;
  url: string;
  host: string | undefined;
  origin: string | undefined;
  body: unknown;
}

/**
 * A stand-in for the external ingest service: same header policy, same statuses.
 *
 * The service lives in another repository. This fake is written from its published
 * protocol so the adapter is proven against the rules a real caller must satisfy,
 * not against our own assumptions about it.
 */
class FakeHost {
  readonly seen: SeenRequest[] = [];
  readonly boundHost = "127.0.0.1";
  /**
   * Address the policy PRETENDS it bound, so a misconfiguration can be reproduced
   * without a second network namespace: the fake listens on loopback while
   * accepting `Host` values for a different address, which is exactly what a host
   * started with `--host 172.17.0.1` does to a caller that addresses it as
   * `127.0.0.1`.
   */
  declaredHost: string | undefined;
  server!: Server;
  port = 0;
  /** Job registry this fake reports, keyed by id. */
  jobs = new Map<string, unknown>();
  /** The `stackId` the proxy actually sent on the last create, or null. */
  lastCreateQuery: string | null = null;
  /** When set, `/api/ingest/jobs` answers 503 as a host without a registry does. */
  trackJobs = true;
  /** Scripted answers for `GET /api/ingest/jobs/:id`, to pin 404 handling. */
  nextJobStatus: number | undefined;
  nextJobBody: unknown = undefined;

  private policyHost(): string {
    return this.declaredHost ?? this.boundHost;
  }

  private acceptedHosts(): string[] {
    // Mirrors buildAcceptableHostHeaders: the bind plus `localhost` on loopback.
    const declared = this.policyHost();
    const accepted = [`${declared}:${this.port}`];
    if (declared === "127.0.0.1" || declared === "::1") accepted.push(`localhost:${this.port}`);
    return accepted;
  }

  private hostAllowed(host: string | undefined): boolean {
    return typeof host === "string" && this.acceptedHosts().includes(host);
  }

  private originAllowed(origin: string | undefined): boolean {
    if (origin === undefined || origin === "") return true;
    try {
      const parsed = new URL(origin);
      return parsed.hostname === this.policyHost() && Number(parsed.port) === this.port;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      this.seen.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        host: req.headers.host,
        origin: req.headers.origin,
        body: text ? JSON.parse(text) : undefined,
      });

      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      // The origin policy runs FIRST, exactly as the real viewer does before
      // dispatching: a rejected request never reaches a handler.
      if (!this.hostAllowed(req.headers.host) || !this.originAllowed(req.headers.origin)) {
        send(403, { error: { code: "forbidden", message: "rejected by origin policy" } });
        return;
      }
      if (req.method === "OPTIONS") {
        // The real host has no preflight branch at all.
        send(404, { error: { code: "not_found", message: "no such route" } });
        return;
      }

      const url = new URL(req.url ?? "/", "http://placeholder");
      const path = url.pathname;
      if (req.method === "POST" && path === "/api/ingest") {
        // Recorded so a test can prove the PROXY sent the Stack, not just that the
        // upstream accepted the call. An assertion on the response alone cannot see
        // a dropped query parameter.
        this.lastCreateQuery = url.searchParams.get("stackId");
        const body = text ? JSON.parse(text) : {};
        if (body.async !== true) {
          // The synchronous path blocks for minutes in reality; a test must never
          // reach it, and if it does this asserts that loudly.
          send(200, { ingested: "synchronous", compileBusy: false });
          return;
        }
        const id = `ing_${this.jobs.size + 1}`;
        const job = {
          id,
          source: body.source,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          ingest: { status: "queued", attempts: [] },
          compile: { status: "queued", progress: null },
        };
        this.jobs.set(id, job);
        send(202, {
          jobId: id,
          status: "queued",
          stage: "queued",
          ingest: job.ingest,
          compile: job.compile,
        });
        return;
      }
      if (req.method === "GET" && path === "/api/ingest/jobs") {
        // A scripted answer applies to the COLLECTION too: the service rejects a
        // malformed `stackId` there, and a fake that could only script single-job
        // reads would let that path go untested.
        if (this.nextJobStatus !== undefined) {
          send(this.nextJobStatus, this.nextJobBody);
          return;
        }
        if (!this.trackJobs) {
          send(503, { error: { code: "jobs_unavailable", message: "this host does not track ingest jobs" } });
          return;
        }
        send(200, { jobs: [...this.jobs.values()].reverse() });
        return;
      }
      if (req.method === "GET" && path.startsWith("/api/ingest/jobs/")) {
        if (this.nextJobStatus !== undefined) {
          send(this.nextJobStatus, this.nextJobBody);
          return;
        }
        if (!this.trackJobs) {
          send(503, { error: { code: "jobs_unavailable", message: "this host does not track ingest jobs" } });
          return;
        }
        const id = decodeURIComponent(path.slice("/api/ingest/jobs/".length));
        const job = this.jobs.get(id);
        if (!job) {
          send(404, { error: { code: "job_not_found", message: `no ingest job '${id}'` } });
          return;
        }
        send(200, job);
        return;
      }
      send(404, { error: { code: "not_found", message: "no such route" } });
    });
    await new Promise<void>((resolve) => this.server.listen(0, this.boundHost, resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  get baseUrl(): string {
    return `http://${this.boundHost}:${this.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("configuration of the ingest service address", () => {
  const base = {
    PI_WORKSPACE_DIR: "/var/lib/chat/workspace",
    CHAT_PROVIDER: "synthetic",
    CHAT_MODEL: "syn:large:text",
    PI_AGENT_CONFIG_MODE: "generate",
  } satisfies NodeJS.ProcessEnv;

  const parse = (env: NodeJS.ProcessEnv) =>
    parseExternalApiConfig(env, {
      urlVar: "INGEST_API_BASE_URL",
      timeoutVar: "INGEST_API_TIMEOUT_MS",
    });

  test("is absent when INGEST_API_BASE_URL is unset, so the routes can say 'not configured'", () => {
    const cfg = loadConfig({ ...base });
    assert.equal(cfg.ingestApi, undefined);
  });

  test("is parsed as an origin, with the default timeout", () => {
    const cfg = parse({ INGEST_API_BASE_URL: "http://172.17.0.1:4173" });
    assert.deepEqual(cfg, { baseUrl: "http://172.17.0.1:4173", timeoutMs: 10_000 });
  });

  test("refuses 0.0.0.0, because that is a bind address and no service answers it", () => {
    assert.throws(
      () => parse({ INGEST_API_BASE_URL: "http://0.0.0.0:4173" }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /must be a reachable address, not 0\.0\.0\.0/);
        return true;
      },
    );
  });

  test("refuses a path in the address, because it is an origin not a route", () => {
    assert.throws(
      () => parse({ INGEST_API_BASE_URL: "http://127.0.0.1:4173/api" }),
      /origin with no path/,
    );
  });

  test("refuses a non-positive timeout instead of hanging forever", () => {
    assert.throws(
      () => parse({ INGEST_API_BASE_URL: "http://127.0.0.1:4173", INGEST_API_TIMEOUT_MS: "0" }),
      /positive number/,
    );
  });
});

describe("the client speaks the host's origin policy", () => {
  const host = new FakeHost();

  before(async () => {
    await host.start();
  });

  after(async () => {
    await host.close();
  });

  test("is accepted with only the configured address, sending no Origin", async () => {
    const client = new IngestClient({ baseUrl: host.baseUrl });
    const res = await client.listJobs();

    // 200, not 403: the Host derived from the URL is the address the host bound.
    assert.equal(res.status, 200);
    const last = host.seen.at(-1);
    assert.equal(last?.host, `127.0.0.1:${host.port}`);
    // Sending an Origin at all would be checking a header nobody needs; absent is
    // the documented way to pass that half of the policy.
    assert.equal(last?.origin, undefined);
  });

  test("forces async:true so the caller can never block for minutes", async () => {
    const client = new IngestClient({ baseUrl: host.baseUrl });
    const res = await client.createJob({ source: "https://example.com/a", compile: true });

    assert.equal(res.status, 202);
    const body = host.seen.at(-1)?.body as Record<string, unknown>;
    assert.equal(body.async, true, "async must be forced, not forwarded");
    assert.equal(body.compile, true);
    assert.equal(body.source, "https://example.com/a");
    assert.match(String((res.body as { jobId?: string }).jobId), /^ing_/);
  });

  test("honours compile:false, which is a real choice and not a mistake", async () => {
    const client = new IngestClient({ baseUrl: host.baseUrl });
    await client.createJob({ source: "https://example.com/b", compile: false });
    const body = host.seen.at(-1)?.body as Record<string, unknown>;
    assert.equal(body.compile, false);
  });

  test("reports an unreachable host as unreachable, not as a job state", async () => {
    // A port nothing listens on: the deployment is configured, the host is down.
    const client = new IngestClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    await assert.rejects(
      () => client.getJob("ing_1"),
      (error: unknown) => {
        assert.ok(error instanceof IngestServiceUnreachable);
        assert.equal(error.reason, "network");
        return true;
      },
    );
  });

  test("a host that accepts connections but never answers times out", async () => {
    const silent = createServer(() => {
      // Deliberately never responds.
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as AddressInfo).port;
    try {
      const client = new IngestClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 200 });
      await assert.rejects(
        () => client.getJob("ing_1"),
        (error: unknown) => {
          assert.ok(error instanceof IngestServiceUnreachable);
          assert.equal(error.reason, "timeout");
          return true;
        },
      );
    } finally {
      silent.closeAllConnections?.();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  test("localhost is accepted as an alias, but a different address is a plain 403", async () => {
    // Accepted alias on a loopback bind: reachable AND allowed.
    const viaLocalhost = new IngestClient({ baseUrl: `http://localhost:${host.port}` });
    assert.equal((await viaLocalhost.listJobs()).status, 200);

    // Now the misconfiguration: the host declares a bind it was started with, and
    // the client addresses a different name. The socket answers, the policy does
    // not — that is the 403 the documentation warns about, reproduced.
    host.declaredHost = "172.17.0.1";
    try {
      const mismatched = new IngestClient({ baseUrl: `http://127.0.0.1:${host.port}` });
      const res = await mismatched.listJobs();
      assert.equal(res.status, 403);
      assert.equal(host.seen.at(-1)?.host, `127.0.0.1:${host.port}`);
    } finally {
      host.declaredHost = undefined;
    }
  });
});

describe("the server proxy preserves what the codes mean", () => {
  const host = new FakeHost();
  let server: Server;
  let baseUrl: string;
  let router: Router | undefined;

  const startProxy = async (options: { configured: boolean }) => {
    router = createRouter({
      authenticate: createAuthenticator({ users: `${USER}:${TOKEN}` }),
    });
    registerIngestRoutes(router, {
      ingest: options.configured
        ? new IngestClient({ baseUrl: host.baseUrl, timeoutMs: 2000 })
        : undefined,
      // These tests cover the source-only path; document resolution has its own
      // file, so the resolver is explicitly absent here.
      documents: undefined,
    });
    const started = await router.listen(0, "127.0.0.1");
    const address = started.address() as AddressInfo;
    return { server: started, baseUrl: `http://127.0.0.1:${address.port}` };
  };

  const headers = {
    "x-dev-token": TOKEN,
    "x-user-id": USER,
    "content-type": "application/json",
  };

  before(async () => {
    await host.start();
    const started = await startProxy({ configured: true });
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    server?.close();
    await host.close();
  });

  test("POST /ingest/jobs answers 202 and never forwards the browser's Host", async () => {
    const res = await fetch(`${baseUrl}/ingest/jobs`, {
      method: "POST",
      headers: {
        ...headers,
        // The browser's own Host and Origin, which the service would reject.
        // Sending them here proves the proxy ignores both.
        origin: "http://localhost:8088",
      },
      body: JSON.stringify({ source: "https://example.com/c" }),
    });

    assert.equal(res.status, 202);
    const accepted = (await res.json()) as { jobId: string; stage: string };
    assert.match(accepted.jobId, /^ing_/);
    assert.equal(accepted.stage, "queued");

    // The upstream saw its OWN address, and no Origin from the browser.
    const upstream = host.seen.at(-1);
    assert.equal(upstream?.host, `127.0.0.1:${host.port}`);
    assert.equal(upstream?.origin, undefined);
  });

  test("GET /ingest/jobs/:id forwards the job snapshot unchanged", async () => {
    host.jobs.set("ing_known", {
      id: "ing_known",
      source: "https://example.com/d",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:12.480Z",
      ingest: {
        status: "running",
        stage: "committing",
        attempts: [
          { attempt: 1, startedAt: "a", endedAt: "b", error: "connection reset" },
          { attempt: 2, startedAt: "c" },
        ],
      },
      compile: { status: "queued", progress: null },
    });

    const res = await fetch(`${baseUrl}/ingest/jobs/ing_known`, { headers });
    assert.equal(res.status, 200);
    const job = (await res.json()) as {
      ingest: { stage: string; attempts: { attempt: number; endedAt?: string }[] };
      compile: { progress: unknown };
    };
    assert.equal(job.ingest.stage, "committing");
    assert.equal(job.ingest.attempts.length, 2);
    assert.equal(job.ingest.attempts[1]?.endedAt, undefined);
    assert.equal(job.compile.progress, null, "null progress must survive the proxy");
  });

  test("stackId is forwarded on the list, so the browser can read another Stack", async () => {
    const before = host.seen.length;
    const res = await fetch(`${baseUrl}/ingest/jobs?stackId=aaaaaaaa-1111-2222-3333-444444444444`, {
      headers,
    });
    assert.equal(res.status, 200);
    const seen = host.seen.at(before);
    assert.match(
      seen?.url ?? "",
      /stackId=aaaaaaaa-1111-2222-3333-444444444444/,
      "the Stack must reach the service, not be dropped at the proxy",
    );
  });

  test("an absent stackId sends NO query, keeping the bound-Stacks behaviour", async () => {
    const before = host.seen.length;
    await fetch(`${baseUrl}/ingest/jobs`, { headers });
    const seen = host.seen.at(before);
    // An empty `?stackId=` would name a Stack called ""; absence is the statement.
    assert.doesNotMatch(seen?.url ?? "", /stackId/);
  });

  test("stackId is forwarded on a single job read too", async () => {
    const before = host.seen.length;
    await fetch(`${baseUrl}/ingest/jobs/ing_x?stackId=bbbbbbbb-1111-2222-3333-444444444444`, {
      headers,
    });
    assert.match(host.seen.at(before)?.url ?? "", /stackId=bbbbbbbb-1111-2222-3333-444444444444/);
  });

  test("400 stays 400: a malformed Stack id is a caller mistake, not an outage", async () => {
    host.nextJobStatus = 400;
    host.nextJobBody = {
      error: { code: "invalid_stack_id", message: "'nope' is not a Stack id." },
    };
    try {
      const res = await fetch(`${baseUrl}/ingest/jobs?stackId=nope`, { headers });
      // 502 would send an operator to look at the deployment for something the
      // caller typed.
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, "invalid_stack_id");
    } finally {
      host.nextJobStatus = undefined;
      host.nextJobBody = undefined;
    }
  });

  test("404 stays 404: this host tracks jobs and never saw that id", async () => {
    const res = await fetch(`${baseUrl}/ingest/jobs/ing_does_not_exist`, { headers });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "job_not_found");
  });

  test("503 stays 503: this host does not track jobs at all", async () => {
    host.trackJobs = false;
    try {
      const res = await fetch(`${baseUrl}/ingest/jobs/ing_1`, { headers });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, "jobs_unavailable");
    } finally {
      host.trackJobs = true;
    }
  });

  test("a 403 travels as 403: a 4xx is the caller's answer, not a service failure", async () => {
    // This test previously asserted 502, which was WRONG and is worth recording:
    // the service answers 403 when its request-header policy rejects this server,
    // and rewriting that into 502 reported a deployment misconfiguration as a
    // transient upstream error. Only a 5xx (other than 503) is the service failing
    // at this call.
    host.nextJobStatus = 403;
    host.nextJobBody = { error: { code: "forbidden", message: "rejected by origin policy" } };
    try {
      const res = await fetch(`${baseUrl}/ingest/jobs/ing_x`, { headers });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error?: { code?: string } };
      // The service's own code arrives unchanged, so a client can branch on it.
      assert.equal(body.error?.code, "forbidden");
    } finally {
      host.nextJobStatus = undefined;
      host.nextJobBody = undefined;
    }
  });

  test("an unscripted 4xx also passes, without being enumerated", async () => {
    // The rule, not a list: a code nobody thought of must still reach the caller.
    // 429 is not handled anywhere in this proxy and must simply travel.
    host.nextJobStatus = 429;
    host.nextJobBody = { error: { code: "rate_limited", message: "slow down" } };
    try {
      const res = await fetch(`${baseUrl}/ingest/jobs/ing_x`, { headers });
      assert.equal(res.status, 429);
      const body = (await res.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, "rate_limited");
    } finally {
      host.nextJobStatus = undefined;
      host.nextJobBody = undefined;
    }
  });

  test("a genuine 5xx is the service failing, so it stays 502", async () => {
    // The other half of the rule: 500 IS the service failing at this call.
    host.nextJobStatus = 500;
    host.nextJobBody = { error: { code: "internal_error", message: "boom" } };
    try {
      const res = await fetch(`${baseUrl}/ingest/jobs/ing_x`, { headers });
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "ingest_service_error");
    } finally {
      host.nextJobStatus = undefined;
      host.nextJobBody = undefined;
    }
  });

  test("409 busy reaches the client as 409, because it is a retry signal", async () => {
    // Swap in a host that refuses with the mutation lock's answer.
    const busy = createServer((req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "busy", message: "another mutation holds the lock" } }));
    });
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    const port = (busy.address() as AddressInfo).port;
    try {
      const busyRouter = createRouter({
        authenticate: createAuthenticator({ users: `${USER}:${TOKEN}` }),
      });
      registerIngestRoutes(busyRouter, {
        ingest: new IngestClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000 }),
      documents: undefined,
      });
      const started = await busyRouter.listen(0, "127.0.0.1");
      const busyBase = `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
      try {
        const res = await fetch(`${busyBase}/ingest/jobs`, {
          method: "POST",
          headers,
          body: JSON.stringify({ source: "https://example.com/e" }),
        });
        assert.equal(res.status, 409);
        const body = (await res.json()) as { error?: { code?: string } };
        assert.equal(body.error?.code, "busy");
      } finally {
        started.close();
      }
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  });

  test("an unconfigured deployment answers 503 with its own code, not a fake 404", async () => {
    const unconfigured = await startProxy({ configured: false });
    try {
      const res = await fetch(`${unconfigured.baseUrl}/ingest/jobs`, { headers });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error?: string; message?: string };
      assert.equal(body.error, "ingest_not_configured");
      assert.match(body.message ?? "", /INGEST_API_BASE_URL/);
    } finally {
      unconfigured.server.close();
    }
  });

  test("a blank source is refused before any upstream call", async () => {
    const before = host.seen.length;
    const res = await fetch(`${baseUrl}/ingest/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "   " }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "invalid_source");
    assert.equal(host.seen.length, before, "no upstream request may be made for a bad body");
  });

  test("the routes need identity like everything else", async () => {
    const res = await fetch(`${baseUrl}/ingest/jobs`);
    assert.equal(res.status, 401);
  });

  test("a create carries the caller's stackId to the upstream", async () => {
    // FOUND IN A LIVE RUN, not by this suite: the picker sent `stackId`, the proxy
    // parsed it and then dropped it, so every upload landed in the endpoint's bound
    // Stack while the UI showed the one the user picked. Nothing failed — the job
    // was created and the response was a cheerful 202, which is why it survived a
    // green suite. Asserting the SENT query is the only way to see it; the response
    // looks identical either way.
    const stackId = "22222222-2222-2222-2222-222222222222";
    host.lastCreateQuery = null;
    const res = await fetch(`${baseUrl}/ingest/jobs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ source: "https://example.com/x", stackId }),
    });
    assert.equal(res.status, 202);
    assert.equal(host.lastCreateQuery, stackId);
  });

  test("a create without a stackId sends none, leaving the endpoint's own Stack", async () => {
    // The complement: omitting it must not become an empty `?stackId=`, which would
    // name a Stack called "".
    host.lastCreateQuery = null;
    const res = await fetch(`${baseUrl}/ingest/jobs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ source: "https://example.com/y" }),
    });
    assert.equal(res.status, 202);
    assert.equal(host.lastCreateQuery, null);
  });
});
