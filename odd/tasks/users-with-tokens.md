# Feature: users-with-tokens

There is no login, and there is not going to be one for this: what the product needs is
three people (alice, bob, carol) each holding a secret of their own, each with their own
conversations, none of them able to act as another. The roster mode that already exists is
the mechanism; what was missing is that it is the deployed posture, that the tokens reach
the server without passing through `.env` or a compose file, and that the operating
procedure is written down.

Scope: `.chat-users` (untracked, never committed), `server/entrypoint.sh`, both compose
files, `deploy/env.prod.example`, `README.md`, two server test files plus one new one,
`server/test/feature-doc.test.ts` (census) and this document.

Status: complete
Branch: feature/users-with-tokens
Created: 2026-11-18
Requester: the repo owner

## Specs

S1 (verbatim, the request):

> "como no hay login , quisiera tener 2 users con tokens o sino 3, y cada uno con sus tokens y su propio chat"

S2. `AUTH_MODE=roster` is the deployed posture in production, and an unknown or misspelled
`AUTH_MODE` still fails the boot instead of falling back to a weaker mode. Nothing about
mode parsing changes.

S3. The roster lives in `.chat-users`, which stays untracked. No token value ever reaches a
commit, an image layer, a log line, a test fixture, a README example or a report: only the
SHAPE (`id:token,id:token`, 32 hex per token) is documented, never a value.

S4. Three users: `alice`, `bob`, `carol`, each with its own token of 32 hex characters from
a CSPRNG.

S5. The tokens reach the server WITHOUT going through `.env` or a compose file:
`.chat-users` is mounted read-only into the container, and the entrypoint exports
`CHAT_USERS` from its contents when `CHAT_USERS` is not already set.

S6. Each user has their own chat and cannot reach another's, proven under roster mode and
with two different tokens — not with two different header names.

S7. Rotation and onboarding are documented as an operational procedure, including that a
roster user with no provisioned `tenant_mcp` rows still chats but gets NO MCP tools — a
silent state the operator must be told about rather than discover.

S8. This feature document exists, follows the repository's convention, and is registered in
the declared census of `server/test/feature-doc.test.ts`.

## Tasks

| ID | Task | Spec | Route | Commit |
|---|---|---|---|---|
| T1 | Generate the roster, mount it read-only in both compose files, export `CHAT_USERS` from it in the entrypoint, prove the export and the ignore rule | S2-S5 | inline | b054685 |
| T2 | Prove token refusal (401 `unauthorized`) and per-token chat isolation against the real authenticator and a real server | S6 | inline | 27aa349 |
| T3 | Write the operating procedure in `README.md`, the deployment template and this document; register the census entry | S7, S8 | inline | this commit |

## Log

L1 (requester's original request, verbatim):

> "como no hay login , quisiera tener 2 users con tokens o sino 3, y cada uno con sus tokens y su propio chat"

L2 (decisions, and why a roster file instead of `.env`):

- **Three users, alice/bob/carol, not two.** S1 offered two or three; three makes the
  "one of the others" case visible in a test (two users can accidentally be symmetric) and
  costs one more entry in a file nothing reads by hand.
- **The tokens come from `node:crypto` `randomBytes(16)`.** 32 hex characters is inside the
  16-64 range `parseRoster` enforces and is not guessable; a hand-typed secret is how a
  roster ends up with `alice:alice-token-aaaaaaaa`, which is fine as a fixture and not fine
  as a deployment.
- **A file, not `.env`.** `.env` is interpolated by Compose into every service that
  references the variable, and it is the file an operator copies around, pastes into a run
  book and asks someone to read over their shoulder. `.chat-users` is one line, read once at
  boot by the entrypoint, mounted read-only, and named in `.gitignore` — so the secret has
  exactly one path into the container and one place to rotate. It also keeps S2 free: a
  misspelled `AUTH_MODE` still stops the boot, and the roster is a separate concern from the
  rest of the environment.
- **The entrypoint does the export, not the compose file.** `${CHAT_USERS}` in the compose
  file would require the value in `.env` — the thing S5 forbids. The mount plus an export in
  `entrypoint.sh` is what lets the compose file carry the shape and never the value.
- **`CHAT_USERS` already set wins over the file.** A deployment that sets it through an
  orchestrator secret, or a test that sets it directly, is not overruled by a file that
  happens to be mounted: the file is a convenience, not an authority.
- **Dev keeps `AUTH_MODE=open`.** The development stack's default was `open` before this
  change and someone cloning the repository has no `.chat-users`; defaulting dev to `roster`
  would fail every clone's first `up` with a message about a file they never had. Dev mounts
  the roster read-only too, so trying roster mode is `AUTH_MODE=roster` in `.env` plus
  creating the file — no edit to the compose file. Production defaults to `roster` and stays
  overridable, because a production stack that boots open by accident is the failure S2
  exists to prevent.
- **A missing roster under `roster` fails the boot, visibly, in the operator's words.** It is
  the difference between "nobody can log in and the reason is in the log" and "the server
  came up healthy and refuses every request".
- **The isolation proof switches the existing file to roster mode instead of adding a
  parallel harness.** `server/test/isolation.test.ts` already created every request through
  one `headers()` helper with a shared token; giving each tenant its own token means every
  ownership assertion in that file (read, turn, rename, delete, sidebar) is now proved with
  two different tokens rather than two header values. The brief predicted this file already
  set up a roster — it did not, it used `shared-token` — so the harness was converted, which
  is the same intent with fewer moving parts.

L3 (out of scope, stated so it is not read as an oversight):

- No login UI, no sign-in form, no password reset, no `users` table. The link carries the
  token; there is nothing to type.
- `AUTH_MODE` stays boot-time. Switching modes is a restart, not a runtime toggle.
- No per-token expiry, no rotation endpoint, no revocation API. Rotation is the documented
  procedure in `README.md`: edit the file, restart, re-hand the link.
- `x-stack-id` is untouched and remains a selection, never an authorisation.

L4 (what was not proven here):

- No container was started and no image was built: the compose changes are proven by
  `docker compose config` renders only, and the entrypoint's export path is proven by
  running the real script against temp directories on the host.
- `server/scripts/provision-mcp.mjs` was not executed against a live MCP host, so "re-run it
  for a new user's tools" is documented from the script's own contract, not observed.
- The database-gated suite (`isolation.test.ts` ownership tests) skips on a machine with no
  reachable Postgres. The token-refusal half of the proof runs without a database and is
  reported as observed.

L5 (evidence, and three places where the brief and the code disagreed):

- **The roster file is ignored by rule `.gitignore:21`, not `:20`.** `git check-ignore -v
  .chat-users` printed `.gitignore:21:.chat-users`, and `roster-hygiene.test.ts` pins the
  rule by source and line shape rather than merely by effect.
- **`server/test/isolation.test.ts` did NOT already set up a roster.** It built its
  authenticator with `createAuthenticator({ devToken: DEV_TOKEN })`, i.e. shared-token
  mode, and sent the same token with two different `x-user-id` values. So the harness was
  CONVERTED rather than extended: one token per tenant, `AUTH_MODE=roster` stated
  explicitly, and every ownership assertion in that file now carries a different secret.
  A ninth test asserts the roster the file builds really has one token per tenant, so the
  Postgres skip cannot hide a harness that would prove the wrong property.
- **`?token=` alone is enough for the API, not for the browser.** `web/src/lib/
  credentials.ts` needs `?user=` before it renders anything (a token with no name is
  treated as a link with no user), and the brief asked for a link where `?user=` is
  optional. No client change was made — none is needed, since the client already forwards
  both values — but the README states the two truths separately instead of promising a
  link shape the client cannot render. The server half is proven:
  `users.test.ts` resolves a request carrying only `x-dev-token` to its owner.
- **Review slice.** The change landed as three commits by unit; the first is 467 authored
  lines because `.chat-users` plus its read-only mount, the entrypoint step and the two
  test files are one behaviour and are reviewed together. T1's commit is the slice
  boundary; T2 adds 155 lines of tests and T3 the prose.
