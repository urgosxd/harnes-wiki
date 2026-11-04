import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Database } from "../src/db/pool.ts";
import { ConversationStore, type Conversation } from "../src/db/conversation-store.ts";
import { TurnService } from "../src/api/turn-service.ts";
import { currentStackId, withStackContext } from "../src/pi/stack-context.ts";
import type { TenantRuntime } from "../src/pi/tenant-runtime.ts";
import { databaseAvailable, openTestDatabase, testUser } from "./support/db.ts";
import { AGENT_DIR, makeWorkspace } from "./support/env.ts";

/**
 * The load-bearing link, end to end through the REAL turn service.
 *
 * The Stack a tool call reads travels on the async chain opened by the turn route, and
 * `turn-service.ts` launches the turn with `void this.execute(...)` inside `start()`.
 * Everything the unit claims rests on that inheritance: the runtime is cached per user
 * and shared by every conversation that user has, so if the chain did not carry the
 * value, a tool call would read whatever the last request happened to leave behind.
 *
 * The seam tests prove the route wraps its call and the proxy reads the context. They
 * cannot prove the value survives `start()` handing work to the background, which is
 * where a `void` call and a DB round trip sit. This one does: a real `TurnService`,
 * a real store, and a `runtimeFor` that records what the context looks like several
 * awaits after the request returned.
 *
 * Two turns of the SAME user run at once, on purpose. That is the shape that would
 * break if the context lived on the runtime instead of the request.
 *
 * The turn never reaches a model — `runtimeFor` answers a stand-in and the turn fails
 * afterwards, which is fine: the recorded value is the fact under test, and skipping
 * the model keeps this gated on Postgres alone rather than on credentials.
 */

const available = await databaseAvailable();
// "Not reachable" would be a lie once the container is healthy but its volume was
// initialised with a password this checkout does not have — the case the harness's
// container-health gate cannot see, and the reason this file gates on a real query.
const skip = available
  ? false
  : "no reachable dev database (docker compose up -d postgres, and the volume's own password)";

let db: Database;
let store: ConversationStore;

before(async () => {
  if (!available) return;
  db = await openTestDatabase();
  store = new ConversationStore(db);
});

after(async () => {
  if (db) await db.close();
});

async function conversationFor(userId: string): Promise<Conversation> {
  return store.create({
    id: randomUUID(),
    userId,
    piSessionId: randomUUID(),
    title: null,
  });
}

test("a turn's Stack survives into the background chain, per request", { skip }, async () => {
  // One user, two conversations: the shared-runtime case, not the easy one.
  const user = testUser("stackturn");
  const first = await conversationFor(user);
  const second = await conversationFor(user);

  const seen: Array<string | undefined> = [];
  let bothStarted = 0;
  let releaseBoth = (): void => {};
  const bothInFlight = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });

  const turns = new TurnService({
    store,
    // Records the context from inside the background chain, and holds both turns until
    // they are provably in flight together — no context can be correct by luck here.
    runtimeFor: async (): Promise<TenantRuntime> => {
      seen.push(currentStackId());
      bothStarted += 1;
      if (bothStarted === 2) releaseBoth();
      await bothInFlight;
      return {} as TenantRuntime;
    },
    workspaceDir: makeWorkspace(),
    agentDir: AGENT_DIR,
    modelFor: () => ({}) as never,
    thinkingLevel: "off",
  });

  const startTurn = (conversationId: string, stackId: string, key: string) =>
    withStackContext(stackId, () =>
      turns.start({ userId: user, conversationId, message: "hi", idempotencyKey: key }),
    );

  const outcomes = await Promise.all([
    startTurn(first.id, "s-a", "turn-a"),
    startTurn(second.id, "s-b", "turn-b"),
  ]);

  for (const outcome of outcomes) {
    assert.equal(outcome.kind, "started", "both turns must start");
    if (outcome.kind !== "started") continue;
    // Drain, so the background work runs to completion before the assertion.
    for await (const _frame of outcome.frames) {
      // frames are not the subject here
    }
  }

  assert.equal(seen.length, 2, "each turn builds its runtime inside its own context");
  assert.deepEqual(
    [...seen].sort(),
    ["s-a", "s-b"],
    "each turn's background chain must see its OWN Stack, never the other's",
  );
  assert.equal(currentStackId(), undefined, "nothing leaks into the test's own context");
});
