#!/usr/bin/env node
/**
 * Stack smoke test. Run against a live compose stack:
 *   node scripts/smoke.mjs [baseUrl]
 *
 * Checks the acceptance criteria that matter end to end: signing in with a real account,
 * a streamed answer, a recalled turn, isolation between two users, and idempotent replay.
 *
 * ## It signs in for real
 *
 * Every request carries the `sid` cookie that `POST /api/login` returned. Nothing here
 * sends `x-user-id` or `x-dev-token`: under the default `AUTH_MODE=password` a header is
 * not identity, and a smoke that used one would be testing a mode the product no longer
 * runs in.
 *
 * Credentials come from the environment, never from this file:
 *
 *   SMOKE_USER=alice SMOKE_PASSWORD=...    node scripts/smoke.mjs
 *   DEFAULT_USERS="alice:<pw>,bob:<pw>"    node scripts/smoke.mjs
 *
 * `DEFAULT_USERS` is the same variable the server seeds with, so a stack started from an
 * `.env` that sets it needs nothing else. When it names one account, the smoke creates its
 * second one through `POST /api/users` — the isolation checks need two identities, and
 * creating one is itself a check that account creation is reachable.
 *
 * A stack where nothing can sign in FAILS LOUDLY, with the server's own status and body.
 * A smoke that skipped authentication would report PASS on a stack nobody could use.
 *
 * It deliberately does not assert a delta count for a one-word reply. That would
 * measure the provider's chunking, not this system, and it reports a false failure
 * on short answers. Streaming is checked with a long answer instead.
 */

import { randomBytes } from "node:crypto";

const base = `${process.argv[2] ?? "http://127.0.0.1:8088"}/api`;
const origin = base.replace(/\/api$/, "");

const results = [];

/** A check that cannot be attempted at all: the stack is not in a state to be tested. */
function fatal(problem, detail) {
  console.error(`\nSMOKE FAILED  ${problem}`);
  if (detail) console.error(`\n${detail}`);
  console.error("\nNothing was verified. Fix the stack (or the credentials below) and re-run.");
  process.exit(1);
}

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * `id:password,id:password` — the same shape and the same parsing rules as the server's
 * `DEFAULT_USERS`, so a value the stack accepted is a value this smoke can use.
 *
 * The first `:` ends the id, both halves are trimmed, and blank entries are skipped.
 */
function parseDefaultUsers(raw) {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator === -1) return undefined;
      const user = entry.slice(0, separator).trim();
      const password = entry.slice(separator + 1).trim();
      return user && password ? { user, password } : undefined;
    })
    .filter((pair) => pair !== undefined);
}

function loadCredentials() {
  const user = (process.env.SMOKE_USER ?? "").trim();
  const password = process.env.SMOKE_PASSWORD ?? "";
  if (user && password) return [{ user, password }];

  const fromDefaults = parseDefaultUsers(process.env.DEFAULT_USERS);
  if (fromDefaults.length > 0) return fromDefaults;

  fatal(
    "no credentials to sign in with",
    "Set SMOKE_USER and SMOKE_PASSWORD, or DEFAULT_USERS=\"alice:<pw>,bob:<pw>\" — the same\n" +
      "value the server was started with. With DEFAULT_USERS unset the two accounts were\n" +
      "created at the first boot with generated passwords, printed once:\n" +
      "    docker compose logs server | grep 'generated password'",
  );
}

/** Sign in, and carry the cookie. Any refusal is a stack fault, so it stops the run. */
async function login({ user, password }, label) {
  const response = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, password }),
  });
  const body = await response.text();

  if (response.status !== 200) {
    fatal(
      `cannot sign in as ${label} (${user})`,
      `POST /api/login answered ${response.status}: ${body}\n` +
        "A 401 means the account does not exist or the password is wrong; 429 means that\n" +
        "account is locked by 10 failures in the last 15 minutes (a restart clears it).",
    );
  }

  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0].trim();
  if (!cookie.startsWith("sid=") || cookie.length <= "sid=".length) {
    fatal(`the login for ${user} set no session cookie`, `set-cookie: ${setCookie || "(none)"}`);
  }

  let account;
  try {
    account = JSON.parse(body).user;
  } catch {
    fatal(`the login for ${user} answered something that is not JSON`, body);
  }
  if (account?.id !== user) {
    fatal(`the login for ${user} named a different account`, body);
  }

  return { user, cookie };
}

const credentials = loadCredentials();
const primary = await login(credentials[0], "the first account");

/** The cookie, and nothing else, is what identifies the caller from here on. */
const auth = (session) => ({ cookie: session.cookie });
const json = (session) => ({ cookie: session.cookie, "content-type": "application/json" });

/**
 * A second identity, for the isolation checks.
 *
 * Taken from the environment when it names two accounts; otherwise created through the
 * product's own endpoint, which is the only way to get one on a stack whose
 * `DEFAULT_USERS` names a single person. Nobody is told about it: `POST /api/users` has no
 * delete counterpart, so this leaves one ordinary account behind, and the id says why.
 */
async function secondAccount() {
  if (credentials[1]) return login(credentials[1], "the second account");

  const user = `smoke-${randomBytes(4).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  const response = await fetch(`${base}/users`, {
    method: "POST",
    headers: json(primary),
    body: JSON.stringify({ user, password, displayName: "Smoke test account" }),
  });
  const body = await response.text();
  if (response.status !== 201) {
    fatal(
      "cannot create the second account the isolation checks need",
      `POST /api/users answered ${response.status}: ${body}\n` +
        "Set DEFAULT_USERS to two accounts to avoid creating one.",
    );
  }
  console.log(`INFO  created a second account for the isolation checks: ${user}`);
  return login({ user, password }, "the second account");
}

const secondary = await secondAccount();

async function createConversation(session, title) {
  const response = await fetch(`${base}/conversations`, {
    method: "POST",
    headers: json(session),
    body: JSON.stringify({ title }),
  });
  if (response.status !== 201) throw new Error(`create failed: ${response.status}`);
  return (await response.json()).id;
}

async function turn(session, conversationId, message, key) {
  const started = Date.now();
  const response = await fetch(`${base}/conversations/${conversationId}/turns`, {
    method: "POST",
    headers: { ...json(session), "idempotency-key": key },
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

const alice = primary;
const bob = secondary;

// 0. The session, and what a name in a header is worth: nothing.
const me = await fetch(`${base}/me`, { headers: auth(alice) });
const meBody = me.status === 200 ? await me.json() : {};
check(
  "the session cookie identifies the account",
  me.status === 200 && meBody.id === alice.user,
  `GET /api/me ${me.status} ${JSON.stringify(meBody.id ?? null)}`,
);

// The impersonation check used to be a SKIP here, because there was no secret to refuse
// anything with: under the old `open` mode, claiming another user id WAS the documented
// behaviour. Under the default `password` mode it is a refusal, so it is an assertion now.
const noCookie = await fetch(`${base}/me`, { headers: { "x-user-id": alice.user } });
const noCookieBody = await noCookie.text();
check(
  "a name in a header does not sign anybody in",
  noCookie.status === 401,
  `status ${noCookie.status} ${noCookieBody.slice(0, 60)}`,
);

const borrowed = await fetch(`${base}/me`, {
  headers: { ...auth(bob), "x-user-id": alice.user },
});
const borrowedBody = borrowed.status === 200 ? await borrowed.json() : {};
check(
  "a session's name cannot be claimed by another session's cookie",
  borrowed.status === 200 && borrowedBody.id === bob.user,
  `${bob.user} asking to be ${alice.user} was answered as ${borrowedBody.id ?? borrowed.status}`,
);

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
const foreign = await fetch(`${base}/conversations/${convBob}`, { headers: auth(alice) });
check("a foreign conversation is not readable", foreign.status === 404, `status ${foreign.status}`);

const foreignTurn = await fetch(`${base}/conversations/${convBob}/turns`, {
  method: "POST",
  headers: { ...json(alice), "idempotency-key": "x" },
  body: JSON.stringify({ message: "leak" }),
});
check("a foreign conversation is not writable", foreignTurn.status === 404, `status ${foreignTurn.status}`);
await foreignTurn.text();

const aliceList = await (await fetch(`${base}/conversations`, { headers: auth(alice) })).json();
check(
  "the sidebar hides other users' conversations",
  !aliceList.conversations.some((conversation) => conversation.id === convBob),
);

// 4. Idempotency: the same key must not append a second turn.
const before = await (await fetch(`${base}/conversations/${convRecall}`, { headers: auth(alice) })).json();
const replay = await fetch(`${base}/conversations/${convRecall}/turns`, {
  method: "POST",
  headers: { ...json(alice), "idempotency-key": "r2" },
  body: JSON.stringify({ message: "What number did I ask you to remember? Reply with just the number." }),
});
await replay.text();
const after = await (await fetch(`${base}/conversations/${convRecall}`, { headers: auth(alice) })).json();
check(
  "a replayed key does not duplicate the turn",
  after.messages.length === before.messages.length,
  `${before.messages.length} -> ${after.messages.length}`,
);

// The link a person is given. It names a Stack and no identity: `?user=` and `?token=` are
// ignored, and signing in is the only thing that names somebody.
const stackId = (process.env.SMOKE_STACK_ID ?? "").trim();
console.log(
  `\nOpen ${origin}/?stackId=${stackId || "<stack-id>"} and sign in as ${alice.user}.`,
);
console.log("That link chooses the Stack; it does not sign anybody in (?user= and ?token= are ignored).");

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
