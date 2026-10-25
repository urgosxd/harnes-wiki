# Feature: pi-chat-mvp

Web chat product on the Pi SDK: independent, saved, resumable conversations for five
users, no development tooling exposed. One Node process runs the agent server; a
separate React client is the product surface.

Status: in progress
Branch: `feature/pi-chat-mvp`
Created: 2026-10-25

## Non-goals (this feature)

- Durable workflows, queues, checkpoint/resume of tool calls, semantic memory.
- More than one agent-server process or a worker per tenant (deferred until crash
  isolation or >~20 concurrent runs is actually needed).
- The built-in Pi MCP extension per session (codemode, `tool_search`, resources,
  `/mcp` UI). Tools are exposed as direct proxied tools instead.
- Any development surface: file browser, terminal, worktrees, git, model settings.

## Decisions already locked (verified by execution, not by reading docs)

| # | Decision | Evidence |
|---|---|---|
| D1 | Pin `@earendil-works/pi-coding-agent` and every `@earendil-works/*` to `1.4.0` exactly. | 0.86.1 exports no MCP symbols at all; `additionalExtensionPaths: ["builtin:mcp"]` resolves to `{extensions: []}`. 1.4.0 exports `createMcpExtension`. |
| D2 | Postgres is the single source of truth for transcript (`session_entries`). Pi session files are not used for storage. | `SessionManager.getEntries()` stays flat during a turn (4,4,...,5). A SIGKILL mid-turn leaves **no file**: `openSync(path,"wx")` runs only after the first assistant message. |
| D3 | The Pi session is rebuilt per turn from DB with `SessionManager.inMemory(cwd, {id}, entries)`. | Recall survives brand-new session objects: "Verde", "4417", "Toto". |
| D4 | MCP: one long-lived `McpClient` per tenant, tools proxied as `customTools`. Not `createMcpExtension` per session. | `createMcpExtension` leaks one child process per session (5 sessions -> 7 `engram` processes; `dispose()` and `reload()` do not reap). Pooling *transports* fails silently (0 tools). One `McpClient` -> 1 process, `close()` -> 0. |
| D5 | `noTools: "builtin"` hides read/bash/edit/write. Business tools carry per-tenant scope inside the `execute` closure. | Built-in tools gone, custom tools retained; acme/globex/initech isolated, `forbidden` reaches the model as a tool result. |
| D6 | `bindExtensions()` is mandatory after `createAgentSession`. | Without it extension tools never register and the model answers "no tengo esa herramienta". |
| D7 | `stopReason` on the persisted assistant message is the run outcome. `prompt()` resolving is not success. | Invalid model: `prompt()` resolves, message persisted with `stopReason: "error"` + `errorMessage: '400 ...'`. |
| D8 | `agent_settled` ends a run, not `agent_end`. | Run event trace: `agent_start, turn_start, message_start x3, message_end x3, message_update x10, turn_end, agent_end, agent_settled`. |
| D9 | Product-level idempotency key per turn; turns are not resumable. | No request replay and no mid-turn resume exist in the SDK. A second `prompt()` on a live session throws `Agent is already processing a prompt...`, which gives a free per-session lock but no crash recovery. |
| D10 | `entry_appended` never fires in SDK mode; persist by diffing `getEntries()`. | Subscribed for a whole turn: zero events. |

## Runtime corrections found during build

| # | Finding | Consequence |
|---|---|---|
| R1 | This machine's global `~/.pi/agent/models.json` stores the synthetic provider's key **inline**, and `~/.pi/agent/auth.json` is `{}`. | A container mounting only `auth.json` starts with zero credentials. The mount and the docs must name `models.json` explicitly. Verified failure mode: `Error: No API key found for the selected model.` |
| R2 | `PI_CODING_AGENT_DIR` changes credential resolution. | Per-tenant agent dirs with an empty one fail with the same error. One shared agent dir for provider credentials; tenant identity is not the credential boundary here. |
| R3 | `~/.pi/agent` is a human dev config: 19 extensions, skills, `AGENTS.md`, themes. | The agent dir is mounted **read-only** and every discovered resource is neutralized by the loader (`noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`). Verified: with all five flags, 0 extensions load. |
| R4 | `systemPromptOverride` does not remove Pi's `<cwd>...</cwd>` section. | `cwd` must point at a neutral workspace, never at a real project path. |

## Tasks

Worked in order. Each task closes with at least one work-unit commit on
`feature/pi-chat-mvp`, tests and docs alongside the behavior.

- [x] T1. Scaffold the agent server workspace and pin Pi 1.4.0
  - Node 22, ESM, TypeScript strict, `npm install --save-exact` for every
    `@earendil-works/*` package, including transitive ones the SDK's own ranges
    resolve (`pi-mcp`, `pi-codemode`, `pi-ai`, `pi-agent-core`).
  - A guard test that fails if any `@earendil-works/*` dependency is not exact.
  - Commit: `chore(server): scaffold with pinned pi 1.4.0`

- [ ] T2. Vertical slice: one conversation, two turns, recall across processes
  - `pi/tenant-runtime.ts`: shared `DefaultResourceLoader` (all five resource flags
    off), `ModelRuntime`, per-tenant `McpClient` proxies, business tools with scope.
  - `pi/session-factory.ts`: rebuild from entries, `createAgentSession`
    (`noTools: "builtin"`), `bindExtensions()`, diff-persist.
  - `pi/events.ts`: `AgentSessionEvent` -> SSE frames; run ends on `agent_settled`.
  - Acceptance: kill the process between turns, restart, the conversation still
    remembers. Unit + e2e test, no HTTP yet.
  - Commit: `feat(server): rebuildable pi session with diff persistence`

- [ ] T3. Postgres schema and the conversation catalog
  - `conversations`, `session_entries` (append-only, `UNIQUE(conversation_id, seq)`),
    `agent_runs` (`UNIQUE(conversation_id, idempotency_key)`), `tenant_mcp`.
  - Migrations runnable without a preinstalled Postgres (Docker Compose service).
  - Title persistence via `appendSessionInfo` / `getSessionName`.
  - Commit: `feat(db): conversation catalog and append-only transcript`

- [ ] T4. HTTP + SSE API with ownership and idempotency
  - `POST /conversations`, `GET /conversations`, `GET /conversations/:id`
  - `PATCH`/`DELETE` for rename and delete
  - `POST /conversations/:id/turns` with `Idempotency-Key`
  - `GET /runs/:id/events` SSE
  - Ownership check before every read, continue, or delete.
  - `stopReason` mapped to run status: `ok | error | aborted | length`.
  - Commit: `feat(api): turns, sse stream and ownership checks`

- [ ] T5. React chat client
  - Sidebar of conversations, new conversation, message list, streaming, retry,
    error states, responsive.
  - No dev surfaces.
  - Commit: `feat(web): chat interface`

- [ ] T6. Isolation and concurrency proof
  - Five concurrent users, two conversations each, no cross-talk, no foreign access.
  - Two simultaneous turns on one conversation rejected by the lock.
  - Reconnect does not duplicate messages (idempotency key).
  - MCP process count does not grow with sessions.
  - Commit: `test(server): five-user isolation and concurrency`

- [ ] T7. Compose stack: agent server + client + Postgres
  - Dockerfile for the server, Dockerfile (or static build) for the client.
  - `~/.pi/agent/models.json` mounted read-only (R1), health checks, private network,
    structured logs.
  - Restart and session-restore acceptance run documented and executed.
  - Commit: `feat(deploy): compose stack with health checks`

## Acceptance checklist

- [ ] Create a conversation and receive a streamed reply.
- [ ] The conversation appears in the sidebar history.
- [ ] Close and reopen the conversation: context preserved.
- [ ] Restart the agent server: sessions restored.
- [ ] Five different users run conversations in parallel.
- [ ] Histories do not mix.
- [ ] Access to another user's conversation is blocked.
- [ ] Two simultaneous runs on one session are prevented.
- [ ] Reconnecting does not duplicate messages.
- [ ] MCP and provider errors lose no saved history.

## Evidence log

| Date | Task | Evidence |
|---|---|---|
| 2026-10-25 | decisions | Spikes in `/tmp/pispike` (0.86.1) and `/tmp/picheck` (1.4.0); findings recorded above. |
| 2026-10-25 | T1 | `857a210`. 7 dep @earendil-works/* all 1.4.0 exact (verified installed tree). 7/7 tests pass, `tsc --noEmit` clean. Pin guard verified both ways: green with exact pins, red (`not ok 1`, `not ok 2`) with a `^1.4.0` range reintroduced. |
| 2026-10-25 | T1 note | `.env.example` is blocked by the harness safety policy (sensitive path). Variables are documented in `README.md` instead; no `.env` file exists in the repo. |
