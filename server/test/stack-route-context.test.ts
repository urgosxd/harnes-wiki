import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRouter } from "../src/http/router.ts";
import { createAuthenticator } from "../src/http/auth.ts";
import { registerRoutes } from "../src/api/routes.ts";
import type { ConversationStore } from "../src/db/conversation-store.ts";
import type { TurnService } from "../src/api/turn-service.ts";
import { currentStackId } from "../src/pi/stack-context.ts";

/**
 * The request context AT THE HTTP BOUNDARY, not at the seam.
 *
 * The unit tests prove the proxy reads a context and the route tests prove the route
 * opens one; this walks the real router over a real socket, which is where header
 * parsing, the trim and the per-request isolation actually live. Two things it pins
 * that nothing inward can:
 *
 *  - NOTHING is inherited between requests. The runtime is cached per user, so a value
 *    that survived a request would show up here as a Stack on a request that named none.
 *  - An ambiguous header is refused rather than guessed. Node joins two `x-stack-id`
 *    lines into `"s-first, s-second"`; taking the first half of that would turn a
 *    malformed request into a read of somebody's Stack.
 *
 * Adapted from the independent verification pass, which reproduced it against a scratch
 * copy; the duplicate-header expectation here is the fail-closed one, which is what the
 * server now does.
 */

async function boot() {
  const seen: Array<string | undefined> = [];
  const turns = {
    async start() {
      seen.push(currentStackId());
      // Background work after an await, the way the real service hands off.
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen.push(currentStackId());
      return { kind: "not_found" as const };
    },
  };
  const router = createRouter({ authenticate: createAuthenticator({ devToken: "tok" }) });
  registerRoutes(router, {
    store: {} as unknown as ConversationStore,
    turns: turns as unknown as TurnService,
  });
  const server: Server = await router.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (extra: Record<string, string>, key: string): Promise<string> =>
    fetch(`${base}/conversations/c1/turns`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dev-token": "tok",
        "x-user-id": "alice",
        "idempotency-key": key,
        ...extra,
      },
      body: JSON.stringify({ message: "hola" }),
    }).then((response) => response.text());
  return { seen, server, base, post };
}

test("route: the header is trimmed, blank or absent means no context, nothing is inherited", async () => {
  const { seen, server, post } = await boot();
  try {
    await post({ "x-stack-id": "  s-a  " }, "k1");
    await post({}, "k2");
    await post({ "x-stack-id": "   " }, "k3");
    await post({ "x-stack-id": "s-b" }, "k4");
  } finally {
    server.close();
  }
  // Two samples per request: before the handoff and after an await inside it.
  assert.deepEqual(seen, ["s-a", "s-a", undefined, undefined, undefined, undefined, "s-b", "s-b"]);
  assert.equal(currentStackId(), undefined, "the request's Stack must not outlive the request");
});

test("route: concurrent requests keep their own Stack", async () => {
  const { seen, server, post } = await boot();
  try {
    await Promise.all([post({ "x-stack-id": "s-a" }, "ka"), post({ "x-stack-id": "s-b" }, "kb")]);
  } finally {
    server.close();
  }
  assert.deepEqual(seen, ["s-a", "s-b", "s-a", "s-b"]);
});

test("route: two x-stack-id lines mean NO context, never the first one", async () => {
  const { seen, server, base } = await boot();
  try {
    // Node joins duplicate headers with ", ", so the array branch cannot be reached by
    // sending twice; this sends the joined value the server would actually receive and
    // one real array, covering both shapes a proxy could produce.
    await sendWithRawDuplicateHeader(base, "kdup");
    await sendWithCommaHeader(base, "kdup2");
  } finally {
    server.close();
  }
  assert.deepEqual(
    seen,
    [undefined, undefined, undefined, undefined],
    "an ambiguous header is refused, not sliced: guessing would read somebody's Stack",
  );
});

/** Two real header lines, which Node exposes as one joined string. */
function sendWithRawDuplicateHeader(base: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${base}/conversations/c1/turns`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dev-token": "tok",
          "x-user-id": "alice",
          "idempotency-key": key,
          "x-stack-id": ["s-first", "s-second"],
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve());
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify({ message: "hola" }));
  });
}

/** The same joined value, sent as a single line. */
function sendWithCommaHeader(base: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${base}/conversations/c1/turns`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dev-token": "tok",
          "x-user-id": "alice",
          "idempotency-key": key,
          "x-stack-id": "s-first, s-second",
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve());
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify({ message: "hola" }));
  });
}
