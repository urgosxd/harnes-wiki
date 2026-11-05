import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { IngestClient } from "../src/ingest/client.ts";
import { registerIngestRoutes } from "../src/api/ingest-routes.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";

/**
 * WHAT THIS FILE PINS
 *
 * `urlparam-stackId.md` S3: the ingest surface must be able to OFFER the Stacks a
 * caller may ingest into, and today the only listing the server owns is the ingest
 * client's private `listStackIds()`. So `GET /stacks` publishes it.
 *
 * Four properties, and each exists for a reason a green suite would otherwise hide:
 *
 *  1. The body is exactly `{"stackIds": string[]}`. Ids only — no names, counts or
 *     pagination. Asserted as a whole object, so a field added later fails here
 *     instead of arriving unnoticed in the browser.
 *  2. An unreadable listing is an EMPTY list, not an error. A choice control with no
 *     Stacks is recoverable; a 500 on a read-only listing breaks the whole ingest
 *     form for a side-channel that the create path already treats as optional.
 *  3. It carries the same identity gate as the neighbouring ingest reads, and it is
 *     a READ: the only thing that reaches the service is `GET /stacks`.
 *  4. Adding it changed nothing else. `POST /ingest/jobs` still refuses an unknown
 *     Stack with `400 unknown_stack` and still accepts a known one, byte for byte.
 *
 * The fake host speaks the service's published protocol (`GET /stacks` answering
 * `[{ id, name }]`, `POST /api/ingest?stackId=` answering 202) because the adapter is
 * what the route calls; the origin-policy half of that protocol has its own file
 * (`ingest-adapter.test.ts`) and is not repeated here.
 */

const USER = "test-user";
const TOKEN = "test-token-value-1234";

interface SeenRequest {
  method: string;
  url: string;
}

/** A stand-in for the ingest service, recording every request it receives. */
class FakeStacksHost {
  readonly seen: SeenRequest[] = [];
  /** What `/stacks` reports. `listStackIds()` narrows these to their `id`. */
  knownStacks: string[] = ["a", "b"];
  /** When true, `/stacks` answers 500, which the client reports as `undefined`. */
  stacksUnreadable = false;
  /** When true, `/stacks` answers 200 with a body that is not an array. */
  stacksNotAList = false;
  /** The `stackId` the proxy actually sent on the last create, or null. */
  lastCreateQuery: string | null = null;

  server!: Server;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Drain: the create body is irrelevant here, but the request must complete.
      }
      this.seen.push({ method: req.method ?? "GET", url: req.url ?? "/" });

      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      const url = new URL(req.url ?? "/", "http://placeholder");
      const path = url.pathname;

      if (req.method === "GET" && path === "/stacks") {
        if (this.stacksUnreadable) {
          send(500, { error: "listing unavailable" });
          return;
        }
        if (this.stacksNotAList) {
          send(200, { stacks: this.knownStacks });
          return;
        }
        send(
          200,
          this.knownStacks.map((id) => ({ id, name: `stack ${id}` })),
        );
        return;
      }
      if (req.method === "POST" && path === "/api/ingest") {
        this.lastCreateQuery = url.searchParams.get("stackId");
        send(202, { jobId: "ing_1", status: "queued", stage: "queued" });
        return;
      }
      send(404, { error: { code: "not_found", message: "no such route" } });
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
}

describe("GET /stacks publishes the Stacks an ingest choice can offer", () => {
  const host = new FakeStacksHost();
  let server: Server;
  let baseUrl: string;

  const headers = {
    "x-dev-token": TOKEN,
    "x-user-id": USER,
    "content-type": "application/json",
  };

  before(async () => {
    await host.start();
    const router = createRouter({
      authenticate: createAuthenticator({ users: `${USER}:${TOKEN}` }),
    });
    registerIngestRoutes(router, {
      ingest: new IngestClient({ baseUrl: host.baseUrl, timeoutMs: 2000 }),
      documents: undefined,
    });
    server = await router.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await host.close();
  });

  test("S3: the ids the service lists, and no other field", async () => {
    host.knownStacks = ["a", "b"];
    const res = await fetch(`${baseUrl}/stacks`, { headers });
    assert.equal(res.status, 200);

    // The WHOLE body: `deepEqual` fails on an extra key, so a count, a name or a
    // pagination envelope added later cannot slip past this.
    assert.deepEqual(await res.json(), { stackIds: ["a", "b"] });
  });

  test("an unreadable or non-list listing is an empty list, not an error", async () => {
    // `listStackIds()` answers `undefined` both when the host fails and when it
    // answers 200 with something that is not an array. Neither may become a 500 on a
    // route whose whole job is to say which Stacks exist.
    host.stacksUnreadable = true;
    try {
      const failed = await fetch(`${baseUrl}/stacks`, { headers });
      assert.equal(failed.status, 200);
      assert.deepEqual(await failed.json(), { stackIds: [] });
    } finally {
      host.stacksUnreadable = false;
    }

    host.stacksNotAList = true;
    try {
      const notAList = await fetch(`${baseUrl}/stacks`, { headers });
      assert.equal(notAList.status, 200);
      assert.deepEqual(await notAList.json(), { stackIds: [] });
    } finally {
      host.stacksNotAList = false;
    }
  });

  test("it needs identity, like the neighbouring ingest reads", async () => {
    const res = await fetch(`${baseUrl}/stacks`);
    assert.equal(res.status, 401);
  });

  test("it is a read: only GET /stacks reaches the service", async () => {
    const before = host.seen.length;
    await fetch(`${baseUrl}/stacks`, { headers });
    assert.deepEqual(
      host.seen.slice(before),
      [{ method: "GET", url: "/stacks" }],
      "a listing route that wrote anything upstream would be a different feature",
    );
  });

  test("a create in an unknown Stack is still refused with the same code and message", async () => {
    // The regression that matters: `GET /stacks` reads the SAME listing the create
    // path validates against. Adding the route must not move, weaken or reword that
    // refusal, and must not reach the upstream for it.
    host.lastCreateQuery = null;
    const res = await fetch(`${baseUrl}/ingest/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "https://example.com/x", stackId: "not-a-known-stack" }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: "unknown_stack",
      message:
        'no Stack "not-a-known-stack" exists. Ask the service for its Stacks and use one of those.',
    });
    assert.equal(host.lastCreateQuery, null, "a refused create must never mint a job id");
  });

  test("a create in a known Stack still passes through", async () => {
    host.lastCreateQuery = null;
    const res = await fetch(`${baseUrl}/ingest/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "https://example.com/x", stackId: "b" }),
    });
    assert.equal(res.status, 202);
    assert.equal(host.lastCreateQuery, "b");
  });
});
