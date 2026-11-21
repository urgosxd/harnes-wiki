# Feature: password-login

Username + password login, a user-creation endpoint, and two seeded default users, with `stackId` staying in the URL and `user`/`token` leaving it.

Branch: `feature/password-login`.

## Specs

S1 — Login takes a user and a password, nothing else. User said: "un login muy simple con user y password nada mas". The login surface has exactly two inputs (`user`, `password`): no email, no URL token, no extra field.

S2 — The stack id stays in the URL. User said: "el stack ID se mantiene en el url". `?stackId=<id>` keeps working exactly as today (`web/src/lib/tenant.ts` is unchanged) and is still sent as `x-stack-id`.

S3 — `user` and `token` leave the URL. User said: "la idea es eliminar el user y token del url". No product URL requires, honours or generates `?user=` or `?token=`; an unauthenticated visit shows the login form instead of an error page.

S4 — An endpoint creates users. User said: "necesito un enpoint para crear usuarios" and "y que se pueda crear users". `POST /api/users` with `{ "user", "password", "displayName"? }`.

S5 — Two default users exist. User said: "ademas de tener 2 usuarios default". On a fresh database two accounts exist and can log in without hand-creation; seeding is idempotent.

S6 — Everyone has the same permissions. User said: "todos con los mismos permisos". No roles, no admin flag, no privileged account; authorization stays the existing per-`user_id` ownership scoping.

## Contract (parent decisions; not user quotes)

- Session: opaque 32-byte token, `HttpOnly` cookie `sid`, `SameSite=Lax`, `Path=/`, 30-day expiry; only its SHA-256 is stored, in `sessions.token_hash`. No token in the URL, no token in web storage.
- Passwords: `scrypt` from `node:crypto`, stored as `scrypt$1$<N>$<r>$<p>$<saltB64>$<hashB64>`. No new dependency.
- `AUTH_MODE=password` is the new mode and the new default; `open`, `roster` and `shared-token` remain only for tests and dev.
- Endpoints: `POST /api/login`, `POST /api/logout`, `GET /api/me`, `POST /api/users`.
- Errors keep the existing shape `{ "error": "<code>", "message": "<text>" }`.
- Default users: `alice` and `bob`; password from `DEFAULT_USERS` (`alice:<pw>,bob:<pw>`) when set, otherwise generated once and logged at startup.
- Frontend copy is English, unchanged convention: `Sign in`, `User`, `Password`, `User or password is incorrect`, `Sign out`.

## Tasks

- T1 — migration `users`/`sessions` + scrypt module. Route: worker. Done in 290ebd7.
- T2 — `AUTH_MODE=password`: sessions, cookie auth, login/logout/me. Route: worker.
- T3 — `POST /api/users`. Route: worker.
- T4 — default-user seeding. Route: worker.
- T5 — frontend login screen, drop `user`/`token` from the URL. Route: worker.
- T6 — docs, scripts, full suites. Route: worker.
- T7 — independent verification (`gentle-ai-verify`). Route: parent.

## Log

L1 (user, verbatim): "Planeo agregar un login , el stack ID se mantiene en el url, necesito un enpoint para crear usuarios , un login muy simple con user y password nada mas, y que se pueda crear users ademas de tener 2 usuarios default, todos con los mismos permisos la idea es eliminar el user y token del url, delega"

L2 (worker): T1 done. Files: `server/src/db/migrations/006_users_and_sessions.sql` (`users`, `sessions`, indexes `sessions_by_user` and `sessions_by_expiry`), `server/src/http/passwords.ts` (`MIN_PASSWORD_LENGTH`/`MAX_PASSWORD_LENGTH`, `scrypt$1$<N>$<r>$<p>$<saltB64>$<hashB64>`, verification with the STORED parameters, malformed stored value is `false` and never a throw), `server/test/passwords.test.ts` (8 tests, public interface only, no database). Checks: `node --experimental-strip-types --test test/passwords.test.ts` 8 pass / 0 fail (RED before the module existed: 1 fail, module missing); `npm test` 413 pass / 0 fail / 44 skipped (457 tests, 14 suites); `npx tsc --noEmit` clean, exit 0. The 006 DDL is NOT verified against Postgres here: the database tier skips in this environment with `needs Postgres`, so it has never been executed against a real server. Commit: 290ebd7.

L3 (parent decision): five facts confirmed against the repository so T2 does not rediscover them. (1) `GET /me` already exists in `server/src/api/routes.ts` and returns `{ "id": userId, "displayName": userId }`; T2 replaces that handler instead of registering a second `/me`. (2) `POST /api/login` and `POST /api/logout` must be added to the router's unauthenticated allowlist beside `/health` in `server/src/http/router.ts`, or login is unreachable: every request without a resolved identity answers 401 before any route runs. (3) `parseAuthMode` in `server/src/http/auth.ts` accepts only `roster`, `shared-token` and `open` and throws on anything else, so it must accept `password`. (4) `docker-compose.yml` still defaults `AUTH_MODE` to `open`; password mode becomes the default in T6. (5) `authenticate` is already async (`(req) => Promise<string | undefined>`, awaited by `createRouter().listen`), so a session lookup needs no signature change. Also confirmed: no route collision — every compiled pattern is anchored (`^...\/?$`) and `:id` is `[^/]+`, so `/login`, `/logout` and `/users` cannot be swallowed by `/conversations/:id`.
