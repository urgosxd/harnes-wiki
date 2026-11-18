# Feature: role-by-volume

A role is text, and text should not need a container to change. One MCP host, a role body
that names its tools the way the model is handed them, and an agent-definitions directory
that is a volume in both stacks and read once per turn instead of once per process.
Scope: the shipped role, both compose files, `server/Dockerfile`, `server/entrypoint.sh`,
a new `server/src/pi/agent-role.ts`, `tenant-runtime.ts`, `turn-service.ts`, `events.ts`,
`main.ts`, the two web files that paint a notice, `README.md`, this document and its tests.

Status: in progress
Branch: feature/role-by-volume
Created: 2026-11-18
Requester: the repo owner

## Specs

S1 (verbatim, the request):

> "saca esos 2 hosts mcp, solo quiero el contenido, y solo habra un solo mcp talvez sea
> mejor que al agente.md sea configurable como los skills por volumen asi se puede corregir
> errores sin deployar todo el container"

and, later:

> "Para no tener problemas con cuantos mcps y permisos, puedo subir archivos .md de agents
> como los ksiils"

S2. The shipped role body names its tools in the BARE spelling the model is handed —
`search_pages`, `query_wiki`, `read_page`, `get_context_pack`, `list_stacks`,
`query_stack` — with no `mcp__…` host prefix and no `llmwiki_kg` half anywhere in the file.
The thinking is preserved, not re-written: the iterative loop, the 6-round budget, the
grounding rule, "limitations you must not paper over", and the stopping rule all stay.

S3. The agents directory is a volume in both stacks, the same shape skills already use.
Development keeps its read-only bind of `./server/agents`. Production gets a NAMED volume
seeded from a copy baked into the image at `/opt/agentdocumentor/agents`, filled by
`server/entrypoint.sh` on a first boot and never over a mount that already has content, so
the prod compose file plus the two images stays a complete deployment. One log line per
state (`seeded` / `already has content`), and a missing seed fails the boot.

S4. The role text reaches the turn's prompt from the file on disk at turn time: editing the
file changes the NEXT turn with the same cached runtime, no restart and no rebuild.

S5. Last-good. If the file is missing, unreadable, or its frontmatter is refused at turn
time, the turn still runs with the previous valid role text and a warning is logged. An
editing mistake must not leave the agent without a role.

S6. Validation at turn time: the tools the body names are compared against the tools the
turn's session is actually provisioned with. A name that is not provisioned is logged AND
surfaced as a visible notice in that turn — the same `details`-carried notice pattern the
Stack divergence uses, i.e. a UI-only field that never rewrites the model's own content —
and the turn proceeds.

S7. Boot keeps failing fast when the SELECTED definition is missing or carries keys this
runtime cannot honor. Unchanged: the per-turn read adds a second, softer path and does not
relax the first.

S8. `AGENT_DEFINITION` still SELECTS, and changing it still needs a restart. That is a
recorded scope boundary, not an implied one: what becomes restart-free is the CONTENT of
the selected file.

S9. Frontmatter rules are unchanged: `name` + `description` only, and a YAML block list is
refused rather than parsed.

S10. This document, plus its entry in the census array in `server/test/feature-doc.test.ts`.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | One MCP host in the shipped role: bare tool names throughout, the provision test adjusted deliberately (both spellings still extracted, liveness proven per spelling), `README.md`, this document and its census entry | S1, S2, S9, S10 | inline | pending |
| T2 | The role as a volume read per turn: seed + named volume in prod, bind in dev, `agent-role.ts` with a last-good cache and tool validation, the `before_agent_start` role section, the `role_notice` frame, plus `role-per-turn.test.ts` and `agents-volume-seed.test.ts` | S3-S8 | inline | this commit — a commit cannot name itself, see `L4` |

## Log

L1 (request, verbatim):

> "saca esos 2 hosts mcp, solo quiero el contenido, y solo habra un solo mcp talvez sea mejor
> que al agente.md sea configurable como los skills por volumen asi se puede corregir errores
> sin deployar todo el container"

> "Para no tener problemas con cuantos mcps y permisos, puedo subir archivos .md de agents
> como los ksiils"

L2 (decisions already taken by the lead, implemented as given, and why):

- **One MCP host only** (S2). The tool references are rewritten, not the reasoning: a role
  that spells a tool `mcp__llmwiki__read_page` is a role written against ONE deployment's
  server name. The bare name is what this product's `tenant_mcp.exposed_tools` column holds
  and what the model is handed, so the bare spelling is the portable one and the prefixed
  one only works while the host keeps its name.
- **Agent definitions become a volume, like skills** (S3). A role is documentation for the
  model, exactly as a skill is, so it gets the same treatment: bind in development, named
  volume seeded from the image in production. The volume is what turns "fix a bad
  instruction" into a `cp` instead of a release.
- **The role is read per turn, not composed at boot** (S4). This is the part that makes "no
  deploy" true rather than aspirational: composing at boot would still need a restart, so
  the fix would still be an operational event. The section moved to the `before_agent_start`
  seam that already carries the turn's Stack, and it is resolved on the turn's own async
  chain so a cached per-user runtime cannot freeze it.
- **`AGENT_DEFINITION` remains a boot-time selection** (S8). Selection is deployment
  configuration, and the file cannot grant anything: tools, model and thinking stay
  deployment concerns (S6's comparison is against what the deployment provisioned). That
  is the point of the feature — a `.md` that could widen its own permissions would be a
  privilege-escalation surface in a text file.

L3 (measurements and what the implementation discovered):

- **`before_agent_start` handlers compose in registration order.** `extensions/runner.js`
  re-renders the prompt for each handler from the options the previous one forced, so
  registering the role factory before the Stack factory appends role-then-Stack and both
  sections stay distinguishable (`# Role: <name>` then `<session_stack>`).
- **The boot path needed one new fact from the loader**: the selected definition's FILE, not
  just its parsed text, because the per-turn read is a read of that path. `loadAgentDefinitions`
  now also returns `files` (name → path); the parse itself is reused unchanged.
- **The notice had to reach the browser through a frame**, and no existing frame carries a
  fact that belongs to no tool. A new `role_notice` frame was added, and the client routes it
  into the surface that already paints the Stack notice — one painted place for "something
  about this turn you should know", rather than a second vocabulary of warnings.

L4 (out of scope, and what stays unproven):

- **Out of scope (S8):** `AGENT_DEFINITION` still needs a restart to change, and the `.md`
  still grants nothing — it cannot add a tool, a model or a thinking level. Both are stated
  in `README.md` rather than implied.
- **Unproven by construction:** no container was started, no image was built and no live MCP
  host was contacted. The volume and seed claims are structural (rendered compose config,
  the executed `entrypoint.sh`) and the per-turn claims are observed against a faux provider,
  never against a real deployment.
- **Unproven by construction:** the notice is proven to leave the server as a `role_notice`
  frame and to be parsed by the client's own frame reader; that a browser paints it was not
  observed in a browser.
- **A composed prompt with a role is only as good as the file**: the validation compares
  names against the session's tool list, so a role whose tools are provisioned for another
  tenant still reports a notice here — by design, since provisioning is per user.
- **Not covered:** the last-good cache has no "first turn, no previous text" fallback beyond
  running without a role, because there is nothing to fall back to. That case logs and
  proceeds; it is not a second-order behaviour anyone asked for.
