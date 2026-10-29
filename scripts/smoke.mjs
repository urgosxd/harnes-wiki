#!/usr/bin/env node
/**
 * Stack smoke test. Run against a live compose stack:
 *   node scripts/smoke.mjs [baseUrl]
 *
 * Checks the acceptance criteria that matter end to end: a streamed answer, a
 * recalled turn, isolation between two users, and idempotent replay.
 *
 * It deliberately does not assert a delta count for a one-word reply. That would
 * measure the provider's chunking, not this system, and it reports a false failure
 * on short answers. Streaming is checked with a long answer instead.
 */

const base = `${process.argv[2] ?? "http://127.0.0.1:8088"}/api`;

/**
 * Two identities, from `USERS` (comma-separated names, default `alice,bob`).
 *
 * There is no secret to load: the name in the request IS the identity, so this test
 * needs nothing but the names it is going to claim.
 */
function loadUsers() {
  const raw = (process.env.USERS ?? "alice,bob").trim();
  const users = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (users.length < 2) {
    throw new Error(
      `need two users to check isolation, found ${users.length}. Set USERS=alice,bob.`,
    );
  }
  return users;
}

const USERS = loadUsers();
const [ALICE, BOB] = USERS;

const headers = (user) => ({
  "x-user-id": user,
  "content-type": "application/json",
});

async function createConversation(user, title) {
  const response = await fetch(`${base}/conversations`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ title }),
  });
  if (response.status !== 201) throw new Error(`create failed: ${response.status}`);
  return (await response.json()).id;
}

async function turn(user, conversationId, message, key) {
  const started = Date.now();
  const response = await fetch(`${base}/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { ...headers(user), "idempotency-key": key },
    body: JSON.stringify({ message }),
  });
  if (response.status !== 200) {
    throw new Error(`turn failed: ${response.status} ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deltaTimes = [];
  let text = "";
  let outcome;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      if (!chunk.startsWith("data: ")) continue;
      const frame = JSON.parse(chunk.slice(6));
      if (frame.type === "text_delta") {
        deltaTimes.push(Date.now() - started);
        text += frame.delta;
      }
      if (frame.type === "run_finished") outcome = frame.outcome;
    }
  }

  return { text, outcome, deltaTimes };
}

const results = [];
const skips = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * A property this suite no longer asserts, recorded rather than deleted.
 *
 * Not counted as a pass: a skipped check that silently counts as success is how a
 * suite starts reporting on things it never verified.
 */
function skip(name, reason) {
  skips.push({ name, reason });
  console.log(`SKIP  ${name} — ${reason}`);
}

// Real roster users, so isolation is checked against the identities the product has.
const alice = ALICE;
const bob = BOB;

// 1. Streaming: a long answer must arrive in pieces, not one burst.
const convStream = await createConversation(alice, "streaming");
const long = await turn(alice, convStream, "Write a paragraph of 80 words about the ocean, no preamble.", "long");
const spread = (long.deltaTimes.at(-1) ?? 0) - (long.deltaTimes[0] ?? 0);
check("long answer streams in multiple deltas", long.deltaTimes.length > 1, `${long.deltaTimes.length} deltas`);
check("deltas arrive over time, not as one burst", spread > 20, `${spread}ms spread`);

// 2. Recall across turns.
const convRecall = await createConversation(alice, "recall");
await turn(alice, convRecall, "Remember the number 7788. Reply with exactly OK.", "r1");
const recall = await turn(alice, convRecall, "What number did I ask you to remember? Reply with just the number.", "r2");
check("second turn recalls the first", /7788/.test(recall.text), JSON.stringify(recall.text.slice(0, 20)));

// 3. Isolation.
const convBob = await createConversation(bob, "bob private");
const foreign = await fetch(`${base}/conversations/${convBob}`, { headers: headers(alice) });
check("a foreign conversation is not readable", foreign.status === 404, `status ${foreign.status}`);

const foreignTurn = await fetch(`${base}/conversations/${convBob}/turns`, {
  method: "POST",
  headers: { ...headers(alice), "idempotency-key": "x" },
  body: JSON.stringify({ message: "leak" }),
});
check("a foreign conversation is not writable", foreignTurn.status === 404, `status ${foreignTurn.status}`);
await foreignTurn.text();

const aliceList = await (await fetch(`${base}/conversations`, { headers: headers(alice) })).json();
check(
  "the sidebar hides other users' conversations",
  !aliceList.conversations.some((conversation) => conversation.id === convBob),
);

// The impersonation check used to live here: bob's token claiming to be alice had to
// be refused. With no secret behind a name there is nothing to refuse it with, so
// the property is gone BY DECISION, not by regression. Kept as a visible SKIP with
// its reason, so the next reader does not rediscover it as a bug — and so that
// turning AUTH_MODE=roster back on is an obvious prompt to restore the assertion.
skip(
  "a token cannot claim another user's identity",
  "no secret behind the name: with AUTH_MODE=open, claiming another user id is the " +
    "documented behaviour, not a failure. Restore this check under AUTH_MODE=roster.",
);

// 4. Idempotency: the same key must not append a second turn.
const before = await (await fetch(`${base}/conversations/${convRecall}`, { headers: headers(alice) })).json();
const replay = await fetch(`${base}/conversations/${convRecall}/turns`, {
  method: "POST",
  headers: { ...headers(alice), "idempotency-key": "r2" },
  body: JSON.stringify({ message: "What number did I ask you to remember? Reply with just the number." }),
});
await replay.text();
const after = await (await fetch(`${base}/conversations/${convRecall}`, { headers: headers(alice) })).json();
check(
  "a replayed key does not duplicate the turn",
  after.messages.length === before.messages.length,
  `${before.messages.length} -> ${after.messages.length}`,
);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (skips.length > 0) {
  console.log(`${skips.length} skipped (see SKIP lines above)`);
}
process.exit(failed.length === 0 ? 0 : 1);
