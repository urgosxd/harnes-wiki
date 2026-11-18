# Feature: skills-volume-and-role

A skill the model is told to open has to be openable. Pi puts each skill's absolute
`<location>` in the system prompt and this product's `read` is confined to the
workspace, so a skill outside it is described and unreachable. Scope: both compose
files, `server/Dockerfile`, one copied agent role, `README.md`, this document and its
tests. No `server/src/` change.

Status: complete
Branch: feature/skills-volume-and-role
Created: 2026-11-18
Requester: the repo owner

## Specs

S1 (verbatim, the request):

> "quiero que skills sea volumen en prod y en dev, y que el agente rol lo formemos aqui, basicamente que sea una copia del agente local wiki-agentic-worflow"

S2. `docker-compose.yml` and `docker-compose.prod.yml` both mount the repo's
`./server/skills` at `<PI_WORKSPACE_DIR>/.pi/skills`, read-only, so the model can open a
skill body with the existing confined `read`.

S3. The image no longer bakes skills; the mount is the only source. A stale baked copy
must not survive to produce duplicate skill names.

S4. `server/agents/wiki-agentic-search.md` exists, frontmatter is exactly `name` +
`description`, and its body is the original's body verbatim.

S5. Nothing about the read/write/ls/grep/find sandbox changes.
`server/src/pi/sandbox.ts` and `server/src/pi/agent-tools.ts` are NOT edited.

S6. Selecting the new role is documented: `AGENT_DEFINITION=wiki-agentic-search`, and it
takes a container restart because definitions are read once at boot
(`server/src/main.ts:98`). Its model and tools are NOT set by the file: `CHAT_MODEL`,
`CHAT_THINKING_LEVEL` and the MCP provisioning in `server/scripts/provision-mcp.mjs`
are.

S7. `README.md` documents both, and corrects the current claim that skills are baked
into the image as the production source.

S8. A new test proves the mechanism at the level that matters: building this repo's
agent tools against a workspace that contains `.pi/skills/<skill>/SKILL.md`, the
confined `read` tool returns the file's body. And a companion test proves the same
`read` still refuses a path outside that workspace (the confinement is not weakened).

S9. A test pins the frontmatter trap: a definition file carrying a YAML block list (or
`model`/`thinking`/`tools`) is refused with a clear error rather than silently accepted
— check whether `server/test/agents.test.ts` or `agent-config.test.ts` already covers it
and extend rather than duplicate; say which you did.

S10. Feature document `odd/tasks/skills-volume-and-role.md` + its entry in the census
array in `server/test/feature-doc.test.ts`.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Skills mounted into the workspace in both compose files, the baked copy removed from the image, the copied wiki role, `README.md`, the S8/S9 tests, this document and its census entry | S1-S10 | inline (no writer definition available in this session) | this commit (see the closing report for its SHA: a commit cannot name itself) |

## Log

L1 (request, verbatim):

> "quiero que skills sea volumen en prod y en dev, y que el agente rol lo formemos aqui, basicamente que sea una copia del agente local wiki-agentic-worflow"

L2 (decisions already made, implemented as given, and why):

- **Skills are mounted INSIDE the workspace** at `<PI_WORKSPACE_DIR>/.pi/skills`, in dev
  and in prod, and not at the user scope `$HOME/.agents/skills`. Pi discovers project
  skills at `<cwd>/.pi/skills` (`resource-loader`/`skills.js`), and the model's `read` is
  confined to the workspace (`server/src/pi/sandbox.ts`, wired into `read` only at
  `server/src/pi/agent-tools.ts:45-51`). Placement is what makes a body readable; the
  sandbox is not widened for it.
- **The baked skills copy is removed from `server/Dockerfile`.** Discovery reads both
  `$HOME/.agents/skills` (user scope) and `<cwd>/.pi/skills` (project scope), so keeping
  the image copy and the workspace mount would list every skill twice under the same
  name. The mount is the single source; the Dockerfile says so where the copy used to be.
- **Agent definitions are not mounted in prod.** The role is authored in the repo
  (`server/agents/`), development bind-mounts it and production bakes it, exactly as
  before. Only skills become a volume.
- **The role file is an adaptation, not a rewrite.** `server/agents/wiki-agentic-search.md`
  carries the original body verbatim and only `name` + `description` in its frontmatter: a
  selected definition carrying `model`, `thinking` or `tools` fails this product's boot
  (`server/src/pi/agents.ts`, selection in `server/src/main.ts`), and a YAML block list
  (`  - item`) throws for every file in the directory.

L3 (findings, recorded and deliberately NOT fixed here):

- **The sandbox is unchanged** (S5). `server/src/pi/sandbox.ts` and
  `server/src/pi/agent-tools.ts` are not edited by this feature.
- **`ls`, `grep` and `find` are NOT confined** to the workspace; only `read` was wired to
  `confinedReadOperations`. Measured during the read-only investigation: the same probe
  that `read` refused returned an outside file through those tools. This is a real gap in
  a boundary the product claims, it is out of this feature's scope, and it is reported
  rather than changed. It means the confinement claim in `README.md` currently holds for
  `read` only.

L4 (what stays unverified):

- **No runnable RED exists for the compose/Dockerfile change.** No unit test can observe a
  mount. The evidence for S2/S3 is structural: `docker compose -f docker-compose.prod.yml
  config` and `-f docker-compose.yml config` render the new mount, and the Dockerfile no
  longer contains a skills `COPY`. The S8/S9 tests were observed RED only where the role
  file was missing (S4); the sandbox and parser behaviour they pin already held, which is
  the point of S5.
- **Nothing was started.** No container, no Postgres, no image build, so the live claim
  "the model reads a skill body in a running stack" is not measured here.
- **Duplicate suppression is argued from the loader, not observed.** Extension, skill and
  prompt discovery read both scopes; the run that would show one list instead of two was
  not performed.
- **A prod deployment must now carry `server/skills` beside the compose file**, because
  the mount names a host path. That is a deployment requirement this feature introduces,
  documented in `README.md`, and not exercised on a real target host.
- **The role names tools this deployment does not grant.** Its body speaks of
  `mcp__llmwiki__read_page`, and `server/scripts/provision-mcp.mjs` deliberately leaves
  `read_page` out of the grant list. The body is kept verbatim (S4); the mismatch is
  recorded, not papered over.
