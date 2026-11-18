# Feature: role-by-volume

A role is text, and text should not need a container to change. One MCP host, a role body
that names its tools the way the model is handed them, and an agent-definitions directory
that is a volume in both stacks and read once per turn instead of once per process.
Scope: the shipped role, both compose files, `server/Dockerfile`, `server/entrypoint.sh`,
a new `server/src/pi/agent-role.ts`, `tenant-runtime.ts`, `turn-service.ts`, `events.ts`,
`main.ts`, the two web files that paint a notice, `README.md`, this document and its tests.

Status: complete
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

S11. The identity rule, pinned. `AGENT_DEFINITION=<name>` is resolved against the declared
frontmatter `name:`, so the applied definition is the file that DECLARES the selected name;
the FILE NAME is not part of the identity. A violation is visible in both places it can
happen: at boot an unknown name fails the start with the names the directory does declare,
and at turn time a file whose `name:` no longer matches the selection is refused — last
valid text, a warning naming both names, and a notice in the turn. Editing only the BODY
must never disturb the selection.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | One MCP host in the shipped role: bare tool names throughout, the provision test adjusted deliberately (both spellings still extracted, liveness proven per spelling), `README.md`, this document and its census entry | S1, S2, S9, S10 | inline | `31720a6` |
| T2 | The role as a volume read per turn: seed + named volume in prod, bind in dev, `agent-role.ts` with a last-good cache and tool validation, the `before_agent_start` role section, the `role_notice` frame, plus `role-per-turn.test.ts` and `agents-volume-seed.test.ts` | S3-S8, S11 | inline | this commit — a commit cannot name itself, see `L5` |

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

L3 (measurements, the operating model, and what the implementation discovered):

**The operating model, stated so nobody infers a hot-swap from the mechanism.** There is
ONE role per deployment, permanently: `AGENT_DEFINITION` is set at deployment and stays,
an operator corrects that role's TEXT in place and the next turn uses it, and no runtime
path switches which role is applied. There is no `.active` marker, no stored selection and
no fallback chain between definitions — the reader is called with the one source the boot
selection produced, and with nothing else. With a single role the restart `AGENT_DEFINITION`
needs is an operation an operator should never have to perform.

- **`before_agent_start` handlers compose in registration order.** `extensions/runner.js`
  re-renders the prompt for each handler from the options the previous one forced, so
  registering the role factory before the Stack factory appends role-then-Stack and both
  sections stay distinguishable (`# Role: <name>` then `<session_stack>`).
- **The identity the selection depends on had to be re-checked per turn.** `loadAgentDefinitions`
  keys a directory by each file's declared `name:`, so the boot selection follows the
  declaration and not the file name. That check runs once, at boot — which left the ONE
  line a per-turn read has to defend: editing `name:` in the volume would have applied a
  role under a name the deployment never selected, silently. The reader now refuses it
  (last valid text, a warning naming both names, a notice in the turn), and a test edits
  that line to prove it. Editing only the body — the normal correction path — cannot move
  the identity, and a test pins that too.
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

L5 (why the last task row does not name a commit): a commit cannot contain its own SHA, and
this branch was asked to be exactly two commits, so `T2` reads "this commit" and points
here. `T1`'s SHA is recorded because a later commit could carry it — the row was written
before the commit that closed it, and the second commit filled it in. The slice is larger
than the usual ~400 authored lines because the feature was asked for as two commits and
the second one holds the whole volume + per-turn change; that is a review-workload fact,
not a size the reviewer can shrink without splitting the feature.

L6 (requester clarification, verbatim, after the work was in flight):

> "1. **There is ONE role, permanently.** They will not switch between roles;
> `AGENT_DEFINITION` is set once at deployment and stays. So: do NOT build any
> role-switching mechanism — no `.active` marker, no selection file, no fallback chain
> between definitions. If you started anything in that direction, drop it. The only thing
> that must be editable at runtime is the CONTENT of the selected role's file, which is
> what S4 already asks for. If you have already written code that reads more than the one
> selected definition per turn, simplify it.
>
> 2. **Document the operating model explicitly**, so nobody infers hot-swap from the
> mechanism: one role, edited in place; you correct its text and the next turn uses it;
> you do not change which role is applied without a restart, and with a single role you
> should never need to. Put that where an operator will read it (README section about
> agent definitions, and `L3` of the feature document), in those terms.
>
> 3. **Pin the identity rule, because uploads create an edge the selection depends on.**
> With `AGENT_DEFINITION=<name>`, decide and TEST what determines the applied definition:
> the FILE NAME, the `name:` frontmatter, or both having to agree. Then make the failure
> visible rather than silent — if an operator renames the file or edits `name:` so they
> disagree, the deployment must not quietly apply nothing or apply a role under the wrong
> name. State which rule you chose, why, and what the operator sees when it is violated.
> Also confirm that editing only the BODY (the normal correction path) never disturbs the
> selection."

What each point changed:

- **1 — nothing to drop.** The reader is called with the single source the boot selection
  produced (`roleReader.resolve(roleSource, …)` in `main.ts`), once per turn; there is no
  selection file, no `.active` marker and no fallback between definitions. Verified by
  reading the wiring, not asserted from memory.
- **2 — stated in `L3` above and in a `#### The operating model: one role, edited in place`
  block in `README.md`**, in those terms: one role, edited in place, no runtime switch.
- **3 — the rule chosen is the declared `name:`** (S11). Why: that is the loader's own
  contract (`loadAgentDefinitions` keys a directory by what each file declares), it lets an
  upload be named anything, and it makes a rename no change of selected role. The turn-time
  check is the new part — the boot check does not run again, so an edited `name:` line would
  otherwise be applied silently. What the operator sees: a startup error listing the
  declared names (boot), or a warning naming both names plus a notice in the turn's output
  (turn time), with the last valid text still applied. Body-only edits are pinned as
  producing neither a warning nor a notice.

L7 (the rendered prompt's ORDER changed, accepted, and pinned by a test):

An independent verification compared the rendered system prompt at base (`ece45e7`) with
this branch and found one ordering change, nothing lost:

- at base: `base prompt → # Role: … → <cwd> → <session_stack>`
- on this branch: `base prompt → <cwd> → # Role: … → <session_stack>`

The cause is the mechanism, not a defect: the role used to be composed at boot and handed
to Pi as the session prompt, so Pi's own sections followed it; it is now appended per turn
to a prompt Pi has already rendered, so it lands after Pi's `<cwd>` block. The role text is
byte-identical and the one order that carries meaning — the standing identity (`# Role: …`)
before the turn's own fact (`<session_stack>`) — is unchanged.

**Decision: accept the new order; do not restore the old one.** Moving Pi's `<cwd>` block
to put the role back where it was would be hand-surgery on another component's output for
zero semantic gain. What the acceptance needs is a guard, so
`server/test/role-prompt-drift.test.ts` asserts the DOCUMENTED order (`<cwd>` before
`# Role:`, `# Role:` before `<session_stack>`), exactly one `# Role:` heading, and that the
boot composition and the per-turn one are identical once the `<cwd>` block is normalized
away — so any OTHER drift still fails. `README.md` states the position in one sentence
where the role and Stack sections are described.

Two smaller reports from the same verification are fixed in the same commit:

- **The log line lied when there had never been a role.** `unusable()` in `agent-role.ts`
  warned "the turn keeps the last valid role text" even on a first turn, which ran with no
  role at all (the notice already said so). The outcome is now appended from the same
  expression the notice uses — "…; this turn ran without a role" versus "…; this turn used
  the last valid role text" — and both branches are pinned by exact-text assertions in
  `role-per-turn.test.ts`, so the words cannot drift from the behaviour again.
- **A missing agents seed spoke in `cp`'s voice.** `cp: cannot stat …` against a target
  `mkdir -p` had just created reads like a permissions problem in the volume, when the
  fault is the image. `entrypoint.sh` now names the empty target and the absent seed, says
  nothing was copied and the boot is stopping, and exits non-zero exactly as before; the
  wording is pinned verbatim in `agents-volume-seed.test.ts`. The skills step is untouched
  beyond sharing the same wording, and `SKILLS_SEED_ONLY` still means what it meant.
