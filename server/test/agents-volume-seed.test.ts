import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

/**
 * S3 of `odd/tasks/role-by-volume.md`: `entrypoint.sh` seeds the AGENTS volume too.
 *
 * Production mounts a NAMED volume over the agents directory, so on a first boot that
 * directory is EMPTY — which means zero definitions: `AGENT_DEFINITION` then fails the
 * boot with "not found" on a deployment that shipped the file, and the failure is in the
 * operator's face at the worst moment. The definitions are baked into the image at
 * `$AGENTS_SEED_DIR` and copied into the volume once, exactly as the skills seed is.
 *
 * The three properties are the ones a careless "just copy it in" would lose silently, and
 * they are the same three the skills seed test pins:
 *
 *   * an empty or missing mount is seeded;
 *   * a mount that already has content is left ALONE — an operator's corrected role wins,
 *     and an image upgrade does not reset it;
 *   * a second boot copies nothing and says so, so `up` twice is `up` once.
 *
 * The script is EXECUTED, not pattern-matched. `entrypoint.sh` seeds both volumes, so this
 * fixture supplies both (a role file and a skill file) and stops after the seeding steps
 * with `AGENTS_SEED_ONLY=1`: the production path continues into `su-exec` and `node`, and a
 * test on a laptop must not need either. Everything lives in a `mkdtemp` under the OS temp
 * root — never in the repository.
 */
const REPO_ROOT =
  process.env.CI_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "server", "entrypoint.sh");
const inCheckout = existsSync(SCRIPT_PATH);
const skip = inCheckout
  ? false
  : "needs the repository checkout (the test image mounts it at CI_REPO_ROOT)";

/** Two definitions, shaped as Pi-herdsman writes them: one `.md` per role. */
const SEED_FILES: Record<string, string> = {
  "wiki-agentic-search.md":
    "---\nname: wiki-agentic-search\ndescription: Agentic search over the wiki.\n---\n\nROLE-BODY-ONE\n",
  "documentor.md": "---\nname: documentor\ndescription: Answers questions.\n---\n\nROLE-BODY-TWO\n",
};

/** One skill, so the step that runs before the agents seed has something to copy. */
const SKILL_SEED_FILES: Record<string, string> = {
  "probe-skill/SKILL.md": "---\nname: probe-skill\ndescription: A skill.\n---\n\nPROBE\n",
};

interface Layout {
  /** The image's copy of the definitions, as `Dockerfile` bakes it. */
  seed: string;
  /** The volume mount the container sees: `$HOME/.agents/agents`. */
  target: string;
  /** The skills seed and mount, which the same script seeds first. */
  skillsSeed: string;
  skillsTarget: string;
}

function layout(t: TestContext): Layout {
  const root = mkdtempSync(join(tmpdir(), "agents-seed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const seed = join(root, "opt", "agentdocumentor", "agents");
  for (const [relative, body] of Object.entries(SEED_FILES)) {
    mkdirSync(dirname(join(seed, relative)), { recursive: true });
    writeFileSync(join(seed, relative), body);
  }
  const skillsSeed = join(root, "opt", "agentdocumentor", "skills");
  for (const [relative, body] of Object.entries(SKILL_SEED_FILES)) {
    mkdirSync(dirname(join(skillsSeed, relative)), { recursive: true });
    writeFileSync(join(skillsSeed, relative), body);
  }

  return {
    seed,
    target: join(root, "home", ".agents", "agents"),
    skillsSeed,
    skillsTarget: join(root, "data", "workspace", ".pi", "skills"),
  };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The entrypoint's two seeding steps, against this fixture, with the paths overridden. */
function runSeed({ seed, target, skillsSeed, skillsTarget }: Layout): Run {
  const result = spawnSync("sh", [SCRIPT_PATH], {
    encoding: "utf8",
    // The script's own defaults are the container's absolute paths; only the directories
    // and the stop-after-seeding switch are replaced. The real environment is not passed
    // through, so an inherited value can never decide a case.
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      SKILLS_SEED_DIR: skillsSeed,
      SKILLS_TARGET_DIR: skillsTarget,
      AGENTS_SEED_DIR: seed,
      AGENTS_TARGET_DIR: target,
      AGENTS_SEED_ONLY: "1",
    },
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

/** Every file under `dir`, relative and sorted — the whole state a copy could disturb. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(current, entry.name), relative);
      else found.push(relative);
    }
  };
  walk(dir, "");
  return found.sort();
}

test("an empty agents mount is seeded from the image's copy", { skip }, (t) => {
  const fixture = layout(t);
  // The named volume: it exists and is empty, which is what Docker hands the container.
  mkdirSync(fixture.target, { recursive: true });

  const result = runSeed(fixture);

  assert.equal(result.status, 0, `seeding must succeed on an empty mount: ${result.stderr}`);
  assert.deepEqual(
    filesUnder(fixture.target),
    Object.keys(SEED_FILES).sort(),
    "the mount must end up holding exactly the seed",
  );
  for (const [relative, body] of Object.entries(SEED_FILES)) {
    assert.equal(
      readFileSync(join(fixture.target, relative), "utf8"),
      body,
      `${relative} must be copied byte for byte: the role's text is the product`,
    );
  }
  assert.match(result.stdout, /agents-seed: .*was empty.*seeded from/);
});

test("an agents mount the container cannot see yet is created and seeded", { skip }, (t) => {
  const fixture = layout(t);
  // No `mkdir`: a volume that was never created, or a HOME wiped between boots.
  assert.equal(existsSync(fixture.target), false);

  const result = runSeed(fixture);

  assert.equal(result.status, 0, `seeding must succeed on a missing mount: ${result.stderr}`);
  assert.deepEqual(filesUnder(fixture.target), Object.keys(SEED_FILES).sort());
  assert.match(result.stdout, /agents-seed: .*was empty.*seeded from/);
});

test("an agents mount that already has content is left untouched", { skip }, (t) => {
  const fixture = layout(t);
  // The operator copied a corrected role in, and edited one that also exists in the seed.
  // Both must survive: seeding is a first-boot action, not a reconciliation, and a fix
  // applied with `cp` must not be undone by the next `docker compose up`.
  const corrected =
    "---\nname: wiki-agentic-search\ndescription: Operator's own.\n---\n\nCORRECTED-ROLE-BODY\n";
  mkdirSync(fixture.target, { recursive: true });
  writeFileSync(join(fixture.target, "wiki-agentic-search.md"), corrected);
  const before = filesUnder(fixture.target);

  const result = runSeed(fixture);

  assert.equal(result.status, 0, `a populated mount must not fail the boot: ${result.stderr}`);
  assert.deepEqual(filesUnder(fixture.target), before, "the populated mount was written to");
  assert.equal(
    readFileSync(join(fixture.target, "wiki-agentic-search.md"), "utf8"),
    corrected,
    "the operator's corrected role was overwritten by the seed",
  );
  assert.equal(
    existsSync(join(fixture.target, "documentor.md")),
    false,
    "a seed-only definition was added to a mount that already had content",
  );
  assert.match(result.stdout, /agents-seed: .*already has content.*left untouched/);
  assert.doesNotMatch(result.stdout, /agents-seed: .*seeded from/, "a skipped seed reported a seed");
});

test("seeding twice seeds once, and the second boot says so", { skip }, (t) => {
  const fixture = layout(t);
  mkdirSync(fixture.target, { recursive: true });

  const first = runSeed(fixture);
  const afterFirst = filesUnder(fixture.target);
  const second = runSeed(fixture);

  assert.equal(first.status, 0, `the first boot must seed: ${first.stderr}`);
  assert.match(first.stdout, /agents-seed: .*was empty.*seeded from/);
  assert.equal(second.status, 0, `the second boot must not fail: ${second.stderr}`);
  assert.deepEqual(filesUnder(fixture.target), afterFirst, "the second boot changed the mount");
  assert.doesNotMatch(second.stdout, /agents-seed: .*seeded from/, "the second boot claimed to seed");
  assert.match(second.stdout, /agents-seed: .*already has content.*left untouched/);
});

test("a missing agents seed fails the boot instead of starting without a role", { skip }, (t) => {
  const fixture = layout(t);
  rmSync(fixture.seed, { recursive: true, force: true });
  mkdirSync(fixture.target, { recursive: true });

  const result = runSeed(fixture);

  // The alternative is the failure this whole step exists to remove: a container that
  // comes up healthy with zero definitions and fails later, in a user's turn.
  assert.notEqual(result.status, 0, "an image with no seed must not pass the seeding step");

  // And the operator is told what is wrong, in this script's own voice. `cp`'s
  // `cannot stat` against a target `mkdir -p` just created reads like a permissions
  // problem in the volume, which sends the reader to the wrong place entirely: the fault
  // is in the IMAGE, and the fix is to rebuild it. Pinned verbatim so a rewording has to
  // be deliberate.
  assert.equal(
    result.stderr,
    `agents-seed: ${fixture.target} is empty and this image carries no seed at ${fixture.seed}\n` +
      `agents-seed: nothing was copied and the boot is stopping here rather than starting ` +
      `without agents; rebuild the image from the deployment's checkout (its agents are ` +
      `baked in at ${fixture.seed}), or mount a directory that already has content\n`,
    `the operator must be told what is missing and what to do: ${result.stderr}`,
  );
  assert.doesNotMatch(result.stderr, /cannot stat/, "the raw `cp` failure must not be what is shown");
  assert.deepEqual(filesUnder(fixture.target), [], "nothing may be copied from a missing seed");
  assert.doesNotMatch(result.stdout, /agents-seed:/, "a failed seed must not claim a state");
});
