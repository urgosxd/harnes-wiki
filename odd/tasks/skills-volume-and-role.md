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
| T1 | Skills mounted into the workspace in both compose files, the baked copy removed from the image, the copied wiki role, `README.md`, the S8/S9 tests, this document and its census entry | S1-S10 | inline (no writer definition available in this session) | f25cf8f |

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

L5 (closing record, appended by `docs(odd)`):

- **The closing commit is `f25cf8f`** (`feat(skills): mount skills inside the workspace
  and ship the wiki search role`). The T1 Commit cell could not carry its own SHA, since
  a commit cannot name itself; this `docs(odd)` commit records it, and the cell now reads
  `f25cf8f`.
- **S8 and the block-list half of S9 had NO RED by design.** The confined `read` already
  returned a body under `<cwd>/.pi/skills` before this feature, and the definition parser
  already threw on a YAML block list (`  - item`), so a test-first failure was not
  available for either: this feature changes PLACEMENT (the mounts), and S5 froze the
  sandbox. The RED that did exist was the role file being absent, which failed 2 tests.
- **The README confinement claim was corrected in this same commit.** It said `read`,
  `grep`, `find` and `ls` were "confined to the workspace". Measured in this session,
  only `read` is: `confinedReadOperations` is wired into `read` alone
  (`server/src/pi/agent-tools.ts:45-51`), and the same probe that `read` refused returned
  the outside file through `ls`, `grep` and `find`. The sentence now names which tool is
  confined and which three are not, and points at `L3`; the gap itself is unchanged and
  no fix is proposed there.
- **Delivery risk, still open with the requester:** prod's skills now come from a host
  `./server/skills` path, so a deployment that carried only the compose file and the
  images no longer discovers any skill.
- **Slice size:** 506 inserted lines in one commit, over the ~400 guidance. The
  single-commit instruction fused the work, and the comment-heavy test and prose files
  account for most of it.

L6 (delivery fix, supersedes the prod half of `S2`/`S3`):

- **The requirement, verbatim:**

  > "docker compose prod debe ser autosuficiente"

- **What broke.** `f25cf8f` mounted `./server/skills` in BOTH compose files. In dev that is
  right. In prod it made the checkout a deployment requirement: `docker-compose.prod.yml`
  consumes images and previously needed no source beside it, so a deployment carrying only
  the compose file and the two images started with **zero** skills and said nothing about
  it. That is the delivery risk `L5` left open, and it is now closed.
- **The design, and why it is this one.**
  - The image carries a **seed** copy of `server/skills` at `/opt/agentdocumentor/skills`.
    That path is at neither discovery scope, which is what keeps `S3`'s reason intact: Pi
    discovers skills at `$HOME/.agents/skills` and `<cwd>/.pi/skills`, so a copy at either
    would list every skill twice. `S3`'s words "the image bakes no skills" are superseded
    in letter, not in intent: the baked copy is never discovered, only copied.
  - Production mounts a **named volume** `agentdoc-skills` at `/data/workspace/.pi/skills`
    and reads no host path at all — that is what self-sufficiency means here: this file
    plus the images is a complete deployment.
  - `server/entrypoint.sh` seeds the volume on the first boot: copy when the mount is
    missing or empty, chown only when `id -u` is 0, do **nothing** when it already has
    content, and log one line either way so the state is observable instead of silent.
  - **An operator wins.** Seeding is a first-boot action, not a reconciliation pass: skills
    copied into the volume, or a seeded skill an operator edited, are never overwritten by
    a restart or an image upgrade. The cost is that an upgrade does not refresh skills —
    remove the volume, or copy over it (`README.md`, **Skills**).
  - A missing seed fails the boot rather than coming up healthy with no skills.
- **What is still true from before.** Development keeps its read-only bind of
  `./server/skills` at the same path and gets no named volume — the mount is the dev
  source, and the seeding step simply finds content there and leaves it alone. `S5` still
  holds: the sandbox is untouched. And the `L3` finding still stands and is still
  unrelated to this fix: `ls`, `grep` and `find` are not confined to the workspace; only
  `read` is.
- **Evidence.** `server/test/entrypoint-skills-seed.test.ts` executes the real
  `entrypoint.sh` against `mkdtemp` directories and was observed RED (4 failures) before
  the seeding step existed, then GREEN: empty mount seeded, missing mount created and
  seeded, populated mount untouched at exit 0, and a second boot that copies nothing and
  claims nothing. `docker compose -f docker-compose.prod.yml config` renders
  `agentdoc-skills` and no skills bind; `docker compose -f docker-compose.yml config`
  still renders the dev bind. The seeding step is reachable on its own through
  `SKILLS_SEED_ONLY=1`, which exists so a test can run it without `su-exec` or root —
  nothing in the compose files or the Dockerfile sets it.
- **Not proved here.** No container was started and no image was built, so the root path
  (chown to `node`, the copy landing in a real Docker volume) and the live claim "the
  model reads a seeded skill body in a deployed stack" are argued from the script and the
  rendered configuration, not measured.
