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

**Amended by a later feature (read this before trusting `S5` or `L3` as current state).**
The tool boundary this document froze is no longer the boundary the repo ships. The role's
tool list and the workspace confinement were closed in
`odd/tasks/prod-hardening.md`, commits `df51ed6` (every read-only tool the role names is
granted) and `7264a1f` (`grep`, `find`, `ls`, and `write`/`edit` under `AGENT_WRITES`, now
refuse any path outside the workspace). `S5` is a historical requirement of THIS feature
and stays as written; the current rule is in `README.md` and in `L8` below.

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
| T1 | Skills mounted into the workspace in both compose files, the baked copy removed from the image, the copied wiki role, `README.md`, the S8/S9 tests, this document and its census entry | S1-S10 | inline (no writer definition available in this session) | `f25cf8f`, `a793ccf` |

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
- **The role names tools this deployment does not grant** — CORRECTED, see `L8`: this was
  true when written and is no longer. Its body speaks of `mcp__llmwiki__read_page` and
  `query_stack`, and `server/scripts/provision-mcp.mjs` then left both out of the grant
  list. The body was kept verbatim (`S4`); the mismatch was recorded rather than papered
  over, and it was closed in `df51ed6`. The bullet is kept here, marked, because the
  finding is what motivated the fix; the current state is `L8`.

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

L7 (test-root fix, the second commit of `T1`):

- **`a793ccf`** (`test(server): resolve the repo root the way the rest of the suite
  does`), and the `T1` Commit cell now carries `f25cf8f`, `a793ccf` in that order.
- **It repairs a defect this branch introduced in `f25cf8f`.**
  `server/test/skills-volume.test.ts` resolved the repository from `import.meta.url`, two
  levels above the test file, so it only found `server/agents` when the checkout sat at
  that depth. Inside `server/Dockerfile`'s `test` stage — which copies `src`, `scripts`
  and `tsconfig.json` but not `agents/` — its two agent-definition assertions resolved
  `/app/agents` and failed on a checkout that does exist. The file now takes the root from
  the `CI_REPO_ROOT ?? ../..` shape the rest of the suite uses, and a checkout-absence
  skip names the missing directory instead of asserting on a path that is not there.
- **The RED that proved it.** In an image-shaped layout (`src`, `scripts`,
  `tsconfig.json`, `test/`, no `agents/`) the file failed 2 of 5. And `CI_REPO_ROOT` set
  to a nonexistent path had previously made no difference at all, because the file
  ignored the variable — that null result is what showed the resolution was the problem
  and not the environment.
- **The assertions still run in CI rather than skip.** `scripts/ci.sh` mounts the
  checkout at `/repo` with `CI_REPO_ROOT=/repo`, so the agent-definition checks execute on
  the real `server/agents` there; the skip covers only a run that has no checkout at all.

L8 (the two findings above are now closed, appended by `prod-hardening`):

Appended, never rewriting `L3` or `L5`: this repo's logs record what was true when it was
written. Both entries stay exactly as they are, and this entry says what changed.

- **The confinement gap in `L3` — and the sentence in `L5` that repeats it — is CLOSED by
  `7264a1f`** (`fix(server): confine the coding tools to the workspace`), `T3` of
  `odd/tasks/prod-hardening.md`. `grep`, `find` and `ls`, and `write` and `edit` when
  `AGENT_WRITES` is on, now refuse any path that resolves outside the workspace, with the
  same `PathEscapeError` vocabulary `read` already used and before the tool touches the
  disk. The paragraph in `README.md` that named the gap and pointed at `L3` has been
  rewritten to state the current boundary.
- **What is still NOT confined is `bash`, and this document never claimed otherwise.**
  A shell reaches whatever the process can, so no path check in a tool can bound it. It is
  off by default (`enableBash` is false unless `AGENT_BASH` is set), and enabling it
  re-opens the hole regardless of the per-tool checks. Reported, not fixed.
- **The `L4` role/provisioning bullet is the one place this document's text was corrected
  in place**, marked and pointed here rather than silently edited, because a reader who
  found `read_page` "deliberately absent" would act on a false premise. It is closed by
  `df51ed6` (`fix(mcp): grant the read-only tools the shipped role names`, `T2` of
  `prod-hardening`): every read-only tool the shipped role names — including `read_page`
  and `query_stack` — is provisioned, eleven tools in total, and the five mutating ones
  stay out.
- **Evidence.** `server/test/sandbox-tools.test.ts` (driving the tool instances
  `createAgentTools` really mounts) and `server/test/provision-mcp.test.ts` (the role file
  parsed for both tool spellings, plus a no-mutating-tool assertion). Whole server suite
  after both commits: 371 tests, 328 pass, 0 fail, 43 skipped. All 43 skips are
  database-gated — this host has no Postgres — and they are: 20 in
  `conversation-store.test.ts` "Postgres is not reachable", 11 in `http-api.test.ts`, 7 in
  `isolation.test.ts` (those also need Pi credentials), 4 in `mcp-http-seam.test.ts` and 1
  in `stack-turn-context.test.ts` "no reachable dev database".
