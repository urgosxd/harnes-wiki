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
 * `entrypoint.sh` seeds the skills volume, and this runs the real script to prove it.
 *
 * Production mounts a NAMED volume over `<workspace>/.pi/skills`, so the directory
 * starts empty and an empty directory means zero skills: the model is told about none
 * and nothing says so. The seed baked at `/opt/agentdocumentor/skills` is copied into
 * that volume on first boot. The three properties below are the ones a careless
 * "just copy it in" would lose silently:
 *
 *   * an empty or missing mount is seeded;
 *   * a mount that already has content is left ALONE — an operator who put their own
 *     skills into the volume wins, and a skill they edited is not reset to the seed;
 *   * a second boot re-logs nothing and copies nothing, so `up` twice is the same as
 *     `up` once.
 *
 * The script is executed, not pattern-matched: the same interpreter the container uses
 * (`sh`, per the shebang) runs it against temp directories. `SKILLS_SEED_ONLY=1` makes
 * it stop after the seeding step, because the production path continues into `su-exec`
 * and `node` — a test runs on a laptop, unprivileged, and must not need either. The
 * conditional `chown` is what makes that same code path safe here: it only runs when
 * `id -u` is 0, which it is in the CI test image and is not on a developer's machine.
 *
 * Neither seed nor mount is anywhere near the repository: every directory is a
 * `mkdtemp` under the OS temp root.
 */
const REPO_ROOT =
  process.env.CI_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "server", "entrypoint.sh");
const inCheckout = existsSync(SCRIPT_PATH);
const skip = inCheckout
  ? false
  : "needs the repository checkout (the test image mounts it at CI_REPO_ROOT)";

/** Two skills, shaped as Pi discovers them: a directory holding a `SKILL.md`. */
const SEED_FILES: Record<string, string> = {
  "skill-alpha/SKILL.md": "---\nname: skill-alpha\ndescription: First seed skill.\n---\n\nALPHA-BODY\n",
  "skill-beta/SKILL.md": "---\nname: skill-beta\ndescription: Second seed skill.\n---\n\nBETA-BODY\n",
};

interface Layout {
  /** The image's copy of the skills, as `Dockerfile` bakes it. */
  seed: string;
  /** The volume mount the container sees: `<workspace>/.pi/skills`. */
  target: string;
}

function layout(t: TestContext): Layout {
  const root = mkdtempSync(join(tmpdir(), "skills-seed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const seed = join(root, "opt", "agentdocumentor", "skills");
  for (const [relative, body] of Object.entries(SEED_FILES)) {
    const path = join(seed, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return { seed, target: join(root, "data", "workspace", ".pi", "skills") };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The entrypoint's seeding step, against this fixture, with the production paths overridden. */
function runSeed({ seed, target }: Layout): Run {
  const result = spawnSync("sh", [SCRIPT_PATH], {
    encoding: "utf8",
    // The script's own defaults are the container's absolute paths; only the two
    // directories and the stop-after-seeding switch are replaced. Passing the real
    // environment through is avoided so an inherited value can never decide a case.
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      SKILLS_SEED_DIR: seed,
      SKILLS_TARGET_DIR: target,
      SKILLS_SEED_ONLY: "1",
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

test("an empty skills mount is seeded from the image's copy", { skip }, (t) => {
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
      `${relative} must be copied byte for byte: the model opens this file`,
    );
  }
  assert.match(result.stdout, /skills-seed: .*was empty.*seeded from/);
});

test("a mount the container cannot see yet is created and seeded", { skip }, (t) => {
  const fixture = layout(t);
  // No `mkdir`: an operator volume that was never created, or a workspace wiped between
  // boots. `-d` on the target is not enough to tell the two states apart.
  assert.equal(existsSync(fixture.target), false);

  const result = runSeed(fixture);

  assert.equal(result.status, 0, `seeding must succeed on a missing mount: ${result.stderr}`);
  assert.deepEqual(filesUnder(fixture.target), Object.keys(SEED_FILES).sort());
  assert.match(result.stdout, /skills-seed: .*was empty.*seeded from/);
});

test("a mount that already has content is left untouched", { skip }, (t) => {
  const fixture = layout(t);
  // An operator copied their own skills in, and edited one that also exists in the seed.
  // Both must survive: seeding is a first-boot action, not a reconciliation.
  const operatorBody = "---\nname: skill-alpha\ndescription: Operator's own.\n---\n\nOPERATOR-BODY\n";
  mkdirSync(join(fixture.target, "skill-alpha"), { recursive: true });
  mkdirSync(join(fixture.target, "operator-skill"), { recursive: true });
  writeFileSync(join(fixture.target, "skill-alpha", "SKILL.md"), operatorBody);
  writeFileSync(join(fixture.target, "operator-skill", "SKILL.md"), "---\nname: operator-skill\n---\n");
  const before = filesUnder(fixture.target);

  const result = runSeed(fixture);

  assert.equal(result.status, 0, `a populated mount must not fail the boot: ${result.stderr}`);
  assert.deepEqual(filesUnder(fixture.target), before, "the populated mount was written to");
  assert.equal(
    readFileSync(join(fixture.target, "skill-alpha", "SKILL.md"), "utf8"),
    operatorBody,
    "the operator's own skill was overwritten by the seed",
  );
  assert.equal(
    existsSync(join(fixture.target, "skill-beta")),
    false,
    "a seed-only skill was added to a mount that already had content",
  );
  assert.match(result.stdout, /skills-seed: .*already has content.*left untouched/);
  assert.doesNotMatch(result.stdout, /seeded from/, "a skipped seed reported a seed");
});

test("seeding twice seeds once, and the second boot says so", { skip }, (t) => {
  const fixture = layout(t);
  mkdirSync(fixture.target, { recursive: true });

  const first = runSeed(fixture);
  const afterFirst = filesUnder(fixture.target);
  const second = runSeed(fixture);

  assert.equal(first.status, 0, `the first boot must seed: ${first.stderr}`);
  assert.match(first.stdout, /was empty.*seeded from/);
  assert.equal(second.status, 0, `the second boot must not fail: ${second.stderr}`);
  assert.deepEqual(filesUnder(fixture.target), afterFirst, "the second boot changed the mount");
  // A copy that ran again would nest the seed (`skills/skill-alpha/...`) or duplicate it;
  // one `SKILL.md` per skill is the whole assertion.
  assert.equal(
    afterFirst.filter((path) => path.endsWith("SKILL.md")).length,
    Object.keys(SEED_FILES).length,
    "the second boot duplicated the skills",
  );
  assert.doesNotMatch(second.stdout, /seeded from/, "the second boot claimed to have seeded");
  assert.match(second.stdout, /already has content.*left untouched/);
});
