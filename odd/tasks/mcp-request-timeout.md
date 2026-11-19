# Feature: mcp-request-timeout

Every MCP tool call is killed at 30 s by a default nobody chose: the client library's own.
`query_wiki` on a large Stack hit exactly that. The deadline becomes ours, configurable, and
120 s by default.

Status: in progress
Branch: fix/mcp-request-timeout
Created: 2026-11-18
Requester: the repo owner

## Specs

S1 (the requester's original request, verbatim, and the number they chose):

> "hay un timeout para tools de mcp ? tuve este problema con la tools query_wiki . El MCP
> devolvió timeout a los 30 s"

The MCP request timeout is configurable through the environment variable
`MCP_REQUEST_TIMEOUT_MS`, and its DEFAULT is `120000` ms. A default, not a constant: an
operator who needs longer changes the environment, not the source. Unset, empty and
whitespace-only all mean "use the default", the way every other optional value in
`server/src/config.ts` is read.

S2 (the wiring, not the number). The value reaches the client: `TenantRuntime.create`
constructs its `McpClient` with `requestTimeoutMs`, so every proxied tool — `query_wiki`
included — inherits it in ONE place instead of per call. A runtime built with no explicit
value uses S1's default (120000), never the library's 30 s, so an omitted argument cannot
silently restore the bug.

S3 (invalid value — fails the boot). A value that is not a positive finite number
(non-numeric, zero, negative) makes `loadConfig` throw a `ConfigError` naming
`MCP_REQUEST_TIMEOUT_MS` and quoting the offending text, and the process exits 1 with the
existing `fatal` JSON line. It does NOT fall back to the default. Why the boot and not a
warning, in this codebase's own terms: `server/src/config.ts:3-4` states the rule —
"Configuration is read once at startup and validated. Nothing here has a silent default" —
and every other timeout and enum there already throws (`INGEST_API_TIMEOUT_MS`,
`CHAT_THINKING_LEVEL`, `PUBLIC_BASE_URL`, `parseExternalApiConfig`). A fallback would leave
an operator believing they had set 300 s while getting 120 s, which is the same class of
invisible default this feature exists to remove.

S4 (operator visibility). The boot log names the effective MCP request timeout exactly once,
as a structured line (`message: "mcp request timeout"`, `timeoutMs: <effective>`), so an
operator can read the live value without reading code. "Effective" is the point: the same
line reports the default when nothing is configured.

S5 (a timeout is a TOOL error, not a turn failure — pinned, not changed). When the deadline
expires, the model receives an `isError: true` tool result carrying the timeout's own
message (`MCP request timed out after <ms>ms`) and the turn continues, so the model can
react — retry with a narrower query, or tell the user. The library already does this (a
thrown `execute` becomes an error tool result); this feature pins it so a future change to
the proxy cannot turn a slow tool into a dead turn.

S6 (nothing else changes). The Stack-scoped injection and its divergence notice, the
per-tool schemas passed through from the server, the fail-closed refusal when a Stack-scoped
call has no Stack, `INGEST_API_TIMEOUT_MS` (the HTTP ingest adapter's deadline, a different
thing), and every chat behaviour stay exactly as they are.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T0 | Feature document, plus the census line in `server/test/feature-doc.test.ts` | S1-S6 | inline | pending |
| T1 | `MCP_REQUEST_TIMEOUT_MS` in `server/src/config.ts`: 120 s default, invalid fails the boot | S1, S3 | inline | pending |
| T2 | `TenantRuntime.create` passes `requestTimeoutMs` to every `McpClient` | S2, S6 | inline | pending |
| T3 | `server/src/main.ts` passes the value and logs the effective one once | S2, S4 | inline | pending |
| T4 | `server/test/mcp-request-timeout.test.ts`: config, boot log, the slow/fast wiring pair, the tool error | S1-S5 | inline | pending |
| T5 | `README.md`, `deploy/env.prod.example` and both compose files pass the variable through | S1, S4 | inline | pending |

## Log

L1 (the requester's original request, verbatim, with the number they chose):

> "hay un timeout para tools de mcp ? tuve este problema con la tools query_wiki . El MCP
> devolvió timeout a los 30 s"

Chosen deadline: `120` seconds (120000 ms).

L2 (the measured cause — not re-derived, measured once and recorded). The MCP client
library defaults every request to 30 s: `server/node_modules/@earendil-works/pi-mcp/dist/client.js:3`
`const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;`, resolved per request at `client.js:263`
(`options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS`) and
expired into `new McpTimeoutError(entry.timeoutMs)` at `client.js:395`, whose message is
`MCP request timed out after <ms>ms` (`protocol/jsonrpc.js:24-31`). Our proxy called
`client.callTool(name, args)` with no options (`server/src/pi/tenant-runtime.ts:587`,
`callAndShape`), so every MCP tool inherited the library's 30 s. Nothing else in this
repository imposes an MCP tool timeout: the agent loop has none, and `INGEST_API_TIMEOUT_MS`
belongs to the HTTP ingest adapter.

L3 (the decision, and why a configurable default beats a hardcoded one). 120 s, as a
default rather than a constant: a tool that legitimately takes longer than a chat reply is
normal for a wiki query over a large Stack, and the right deadline depends on the Stack, so
a number baked into the source would be wrong for the next operator and invisible to them.
`TenantRuntime.create` sets it once on the `McpClient`, which is where the library reads it
from, so per-call options are neither needed nor wanted. Invalid values fail the boot
(S3) rather than warn, following `config.ts`'s existing rule that nothing at startup has a
silent default.

L4 (what this does NOT prove, and what it deliberately excludes). No live wiki host was
contacted: the wiring is proven against a stand-in streamable-HTTP MCP server whose
`tools/call` is slow, plus the seam the code uses (`McpClient` constructed with
`requestTimeoutMs`, reported on the runtime). That proves the number reaches `callTool` and
that a timeout surfaces as a tool error; it does not prove how a particular production host
behaves under a long query. Per-tool timeouts (a different deadline for `query_wiki` than
for `list_stacks`) are OUT OF SCOPE and named as such: one deadline for one runtime is the
request, and a per-tool table would be a policy nobody asked for.
