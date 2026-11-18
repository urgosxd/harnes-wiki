import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { IngestClient } from "../src/ingest/client.ts";
import { registerIngestRoutes } from "../src/api/ingest-routes.ts";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";

/**
 * WHAT THIS PINS
 *
 * The web client renders a job payload's `dimensions` array, and this server is a proxy
 * in front of the service that produces it. The route is already a pass-through — it
 * re-serializes whatever the host answered and adds nothing — but nothing in this suite
 * fed a body carrying a field the proxy does not itself know about, so "it forwards
 * unknown fields" was assumed rather than measured. That is exactly the shape of gap
 * where a future "normalize the payload" change deletes a dimension silently: the job
 * still renders, the `wiki`/`kg` results are just gone.
 *
 * So the fake host answers a job body with `dimensions` (and one field no part of this
 * repository reads) and the test compares the bytes.
 */

const USER = "test-user";
const TOKEN = "test-token-value-1234";

/**
 * The job the host answers, in the shape the producer publishes: two state machines,
 * per-dimension results, and a `schemaVersion` that this repository does not read.
 *
 * Written out as an object and serialized with `JSON.stringify` on BOTH sides, so the
 * comparison below is of bytes: the proxy must not add a field, drop one, reorder one or
 * rename one.
 */
const JOB_WITH_DIMENSIONS = {
  id: "ing_01J8Z4Q7X3",
  source: "https://example.com/article",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:12.480Z",
  ingest: { status: "succeeded", stage: "committing", attempts: [] },
  compile: {
    status: "succeeded",
    stage: "finalize",
    progress: null,
    message: "Compiled wiki and kg.",
  },
  dimensions: [
    { name: "wiki", status: "succeeded", summary: "wiki:created" },
    { name: "kg", status: "succeeded", summary: "kg:12 chunks, 3 entities" },
  ],
  schemaVersion: 3,
};

/** An upstream that answers one job snapshot, and nothing else. */
class SnapshotHost {
  readonly seen: string[] = [];
  server!: Server;
  port = 0;
  /** The literal bytes the next snapshot read receives. */
  body = JSON.stringify(JOB_WITH_DIMENSIONS);

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.seen.push(`${req.method ?? "GET"} ${new URL(req.url ?? "/", "http://x").pathname}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(this.body);
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

describe("a job body carrying dimensions reaches the client unchanged", () => {
  const host = new SnapshotHost();
  let server: Server;
  let baseUrl: string;

  before(async () => {
    await host.start();
    const router = createRouter({
      authenticate: createAuthenticator({ users: `${USER}:${TOKEN}` }),
    });
    registerIngestRoutes(router, {
      ingest: new IngestClient({ baseUrl: host.baseUrl, timeoutMs: 2000 }),
      documents: undefined,
    });
    const started = await router.listen(0, "127.0.0.1");
    server = started;
    baseUrl = `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await host.close();
  });

  test("the bytes are the host's bytes, dimensions included", async () => {
    const stackId = "aaaaaaaa-1111-2222-3333-444444444444";
    const res = await fetch(`${baseUrl}/ingest/jobs/ing_01J8Z4Q7X3?stackId=${stackId}`, {
      headers: { "x-dev-token": TOKEN, "x-user-id": USER },
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    // The read really went to the service's own job path.
    assert.deepEqual(host.seen, ["GET /api/ingest/jobs/ing_01J8Z4Q7X3"]);

    // Byte for byte: no field added, dropped, renamed or reordered on the way through.
    assert.equal(text, host.body);

    // And the two facts the panel depends on are readable from what the client gets:
    // one entry per dimension, in the producer's order, each with its own status.
    const parsed = JSON.parse(text) as { dimensions?: Array<Record<string, unknown>> };
    assert.deepEqual(parsed.dimensions, [
      { name: "wiki", status: "succeeded", summary: "wiki:created" },
      { name: "kg", status: "succeeded", summary: "kg:12 chunks, 3 entities" },
    ]);
    // A field this repository never reads still travels: the proxy forwards the host's
    // payload, it does not curate it.
    assert.equal((parsed as Record<string, unknown>).schemaVersion, 3);
  });

  test("a job with no dimensions is forwarded unchanged too, so the fallback is not an artifact", async () => {
    // The other side of the same rule: the proxy does not ADD a `dimensions` array for a
    // job the host did not give one for. If it did, every old job would render the new
    // rows and the fallback would only ever be visible in a fixture.
    const withoutDimensions: Record<string, unknown> = { ...JOB_WITH_DIMENSIONS };
    delete withoutDimensions.dimensions;
    host.body = JSON.stringify(withoutDimensions);

    const res = await fetch(`${baseUrl}/ingest/jobs/ing_01J8Z4Q7X3`, {
      headers: { "x-dev-token": TOKEN, "x-user-id": USER },
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.equal(text, host.body);
    assert.equal(Object.hasOwn(JSON.parse(text) as object, "dimensions"), false);
  });
});
