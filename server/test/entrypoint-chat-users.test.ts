import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

/**
 * `entrypoint.sh` carries the roster from a mounted file into `CHAT_USERS`.
 *
 * The tokens must not travel through `.env` or through a compose file: `.env` is
 * interpolated into every service that names the variable and is the file an operator
 * copies around, while `.chat-users` is one line, read once at boot, mounted read-only
 * and git-ignored. So the compose files mount the file and the entrypoint is the only
 * thing that turns it into an environment variable.
 *
 * Four properties, and each one is a state a container actually boots in:
 *
 *   * the file is present and `CHAT_USERS` is not set -> the roster is exported;
 *   * `CHAT_USERS` is already set -> it wins, and the file is not read;
 *   * neither exists, and the mode is not `roster` -> the boot continues without it
 *     (that is the development stack, which defaults to `open`);
 *   * neither exists (or the mount is empty, or Docker made it a directory because the
 *     host file was missing), and the mode IS `roster` -> the boot stops, in words that
 *     tell the operator what to do. A server that came up healthy and refuses every
 *     request is the failure this exists to remove.
 *
 * The script is executed, not pattern-matched: `sh`, the interpreter its shebang names,
 * runs it against temp directories. `CHAT_USERS_EXPORT_ONLY` makes it stop after the
 * roster step, because the production path continues into `su-exec` and `node` — a test
 * runs on a laptop, unprivileged, and must need neither. Any remaining arguments are
 * exec'd, which is how the exported value is read back without printing a token into a
 * log: the probe prints it to the test's own stdout buffer, never to the container's.
 *
 * Every value below is a self-evident placeholder (`not-a-real-token-fixture-…`), not a
 * token from any deployment: a fixture is where a secret goes to be committed.
 */
const REPO_ROOT =
  process.env.CI_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "server", "entrypoint.sh");
const skip = existsSync(SCRIPT_PATH)
  ? false
  : "needs the repository checkout (the test image mounts it at CI_REPO_ROOT)";

const ALICE = "not-a-real-token-fixture-alice";
const BOB = "not-a-real-token-fixture-bob-0";
const CAROL = "not-a-real-token-fixture-carol";
const ROSTER = `alice:${ALICE},bob:${BOB},carol:${CAROL}`;

interface Fixture {
  /** The read-only mount the container sees. */
  mount: string;
  /** The file itself, when a case wants to write it. */
  file: string;
  /** Where the probe writes the value the script exported. */
  probe: string;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "chat-users-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Docker's own path in the container, reproduced under the temp root so nothing the
  // test does can reach a real mount and no path here is inside the repository.
  const mount = join(root, "run", "secrets");
  mkdirSync(mount, { recursive: true });
  return { mount, file: join(mount, "chat-users"), probe: join(root, "probe.txt") };
}

interface Run {
  status: number | null;
  /** What `CHAT_USERS` held when the script reached its stop point. */
  exported: string;
  stdout: string;
  stderr: string;
}

/**
 * Run the roster step, then have the script `exec` a probe that RECORDS the variable.
 *
 * The probe is passed as arguments and the script ends in `exec "$@"`, so what is
 * recorded is the child's `$CHAT_USERS`: the same variable the server process would
 * inherit, not a value the test re-derived from the file. It writes to a file rather
 * than to stdout on purpose — stdout belongs to the script, and a test about "the
 * entrypoint never prints a roster" cannot share a stream with the proof that the
 * roster arrived intact.
 */
function runRoster({ mount, probe }: Fixture, env: Record<string, string> = {}): Run {
  const result = spawnSync(
    "sh",
    [SCRIPT_PATH, "sh", "-c", 'printf "%s" "${CHAT_USERS-<unset>}" > "$PROBE_FILE"'],
    {
      encoding: "utf8",
      // The real environment is NOT passed through: an inherited `CHAT_USERS` or
      // `AUTH_MODE` would decide a case. Only PATH survives.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CHAT_USERS_FILE: join(mount, "chat-users"),
        CHAT_USERS_EXPORT_ONLY: "1",
        PROBE_FILE: probe,
        ...env,
      },
      timeout: 30_000,
    },
  );
  return {
    status: result.status,
    exported: existsSync(probe) ? readFileSync(probe, "utf8") : "",
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

test("a mounted roster is exported as CHAT_USERS", { skip }, (t) => {
  const layout = fixture(t);
  writeFileSync(layout.file, `${ROSTER}\n`);

  const result = runRoster(layout);

  assert.equal(result.status, 0, `the boot must continue with a roster present: ${result.stderr}`);
  assert.equal(
    result.exported,
    ROSTER,
    "CHAT_USERS must hold the file's contents, byte for byte and without the trailing newline",
  );
  assert.match(result.stdout, /chat-users: .*exported/i);
});

test("a roster file without a trailing newline exports the same value", { skip }, (t) => {
  const layout = fixture(t);
  writeFileSync(layout.file, ROSTER);

  const withNewline = fixture(t);
  writeFileSync(withNewline.file, `${ROSTER}\n`);

  // Both must be the roster AND the same: two empty exports would also be equal, and
  // an entrypoint that exported nothing at all would pass a bare equality check.
  const withoutNewline = runRoster(layout);
  const trailing = runRoster(withNewline);
  assert.equal(withoutNewline.exported, ROSTER);
  assert.equal(trailing.exported, ROSTER);
});

test("CHAT_USERS already set wins, and the file is not read", { skip }, (t) => {
  const layout = fixture(t);
  // A different roster ON DISK, so "the value came from the environment" is observable
  // rather than indistinguishable from "the file happened to agree".
  writeFileSync(layout.file, `dave:${"not-a-real-token-fixture-dave"}\n`);
  const fromEnvironment = ROSTER;

  const result = runRoster(layout, { CHAT_USERS: fromEnvironment });

  assert.equal(result.status, 0, `an explicitly set CHAT_USERS must not fail the boot: ${result.stderr}`);
  assert.equal(result.exported, fromEnvironment, "the mounted file overruled an explicit CHAT_USERS");
  assert.match(result.stdout, /already set/i);
});

test("with no roster file and no roster mode, the boot continues without one", { skip }, (t) => {
  const layout = fixture(t);

  const result = runRoster(layout);

  assert.equal(result.status, 0, `the development stack must boot without a roster: ${result.stderr}`);
  assert.equal(result.exported, "<unset>", "CHAT_USERS must not be invented when there is no roster");
  assert.match(result.stdout, /chat-users: .*no roster/i);
});

test("roster mode with no roster file stops the boot and says what to do", { skip }, (t) => {
  const layout = fixture(t);

  const result = runRoster(layout, { AUTH_MODE: "roster" });

  assert.notEqual(result.status, 0, "AUTH_MODE=roster without a roster must not boot");
  assert.equal(result.exported, "", "nothing was exported, so nothing may be printed as the roster");
  assert.match(result.stderr, /chat-users:/);
  assert.match(result.stderr, /AUTH_MODE=roster/);
  assert.match(result.stderr, /chat-users/, "the message must name the file the operator has to create");
  assert.match(result.stderr, /restart/i, "the message must say what recovers the boot");
});

test("roster mode with an empty roster file stops the boot instead of refusing everyone", { skip }, (t) => {
  const layout = fixture(t);
  writeFileSync(layout.file, "   \n\n");

  const result = runRoster(layout, { AUTH_MODE: "roster" });

  assert.notEqual(result.status, 0, "an empty roster under roster mode is a configuration error");
  assert.match(result.stderr, /chat-users:/);
});

test("roster mode with a directory where the file belongs stops the boot", { skip }, (t) => {
  // What Docker does to a short-syntax bind whose host path does not exist: it creates
  // an empty DIRECTORY at the target. Distinguishing it from "no mount at all" is the
  // difference between a diagnosis and a wild guess.
  const layout = fixture(t);
  mkdirSync(join(layout.mount, "chat-users"));

  const result = runRoster(layout, { AUTH_MODE: "roster" });

  assert.notEqual(result.status, 0, "a directory is not a roster");
  assert.match(result.stderr, /chat-users:/);
  assert.match(result.stderr, /directory/i);
});

test("a roster is never printed, in any state", { skip }, (t) => {
  const layout = fixture(t);
  writeFileSync(layout.file, `${ROSTER}\n`);

  const present = runRoster(layout, { AUTH_MODE: "roster" });
  const missing = runRoster(fixture(t), { AUTH_MODE: "roster" });

  for (const result of [present, missing]) {
    for (const token of [ALICE, BOB, CAROL]) {
      assert.doesNotMatch(result.stdout, new RegExp(token), "the entrypoint printed a token");
      assert.doesNotMatch(result.stderr, new RegExp(token), "the entrypoint printed a token");
    }
  }
  // The exported value IS the roster; the point is that nothing else may say so.
  assert.equal(present.exported, ROSTER);
});
