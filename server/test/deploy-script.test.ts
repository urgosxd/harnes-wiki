import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

/**
 * `scripts/deploy.sh` — the validator, exercised the way an operator runs it: `--check`.
 *
 * The script is the only thing standing between a placeholder `.env.prod` and a volume
 * whose `POSTGRES_PASSWORD` was baked in on the first initdb, and it had no test. Every
 * case below runs `--check`, which is the mode that validates and stops before any docker
 * command, so the suite needs neither docker nor a database.
 *
 * Two properties are asserted beyond the exit codes, because they are the ones a broken
 * refactor would take away silently:
 *   * `--check` reaches no deployment step — the passing case never prints `==> pulling`,
 *     which is the first line deploy mode prints before `docker compose pull`;
 *   * no value that could be a secret is ever echoed, on either stream.
 *
 * Each test writes its env file into its own `mkdtemp` directory and always passes
 * `--env-file <that file>`, so no run can read or create a real `.env.prod` in the repo.
 */
// `CI_REPO_ROOT` is how the CI container points the suite at its read-only mount of the
// checkout; locally the repository is two levels above `server/test/`. Resolved rather
// than hardcoded so the test runs from any checkout location.
const REPO_ROOT =
  process.env.CI_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "deploy.sh");
const inCheckout = existsSync(SCRIPT_PATH);
const skip = inCheckout
  ? false
  : "needs the repository checkout (an image has no scripts/ above test/)";

/**
 * Every variable the script reads, deleted from the child's environment.
 *
 * The script mirrors compose precedence: an EXPORTED value beats the env file, because
 * `docker compose --env-file` never overrides the shell. That is correct for operators and
 * hostile to a test — an inherited `VERSION` or `CHAT_API_KEY` on whatever machine runs the
 * suite would replace the value each test wrote, and the assertions would pass or fail by
 * accident. So the inherited copies are removed and the env file is the only source.
 */
const DEPLOY_VARIABLES = [
  "VERSION",
  "POSTGRES_PASSWORD",
  "REGISTRY",
  "CHAT_API_KEY",
  "CHAT_PROVIDER",
  "CHAT_MODEL",
  "CHAT_THINKING_LEVEL",
  "PI_WORKSPACE_DIR",
  "PI_AGENT_DIR",
  "PI_AGENT_CONFIG_MODE",
  "AUTH_MODE",
  "INGEST_API_BASE_URL",
  "PUBLIC_BASE_URL",
];

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of DEPLOY_VARIABLES) delete env[name];
  return env;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  // `sh` explicitly: the script is POSIX sh (its shebang is `/usr/bin/env sh`, and the
  // header says bash may be missing on the target host), so the test runs the interpreter
  // the deployment actually uses rather than whatever the checkout's file mode selects.
  const result = spawnSync("sh", [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: cleanEnv(),
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

/** A temp directory removed when the test ends. */
function scratchDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Write an env file in its own temp dir. A `null` value means the key is ABSENT from the
 * file, which is how a missing-variable case is expressed.
 */
function writeEnvFile(t: TestContext, values: Record<string, string | null>): string {
  const path = join(scratchDir(t, "deploy-script-"), ".env.prod");
  const body = Object.entries(values)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  writeFileSync(path, `${body}\n`, { mode: 0o600 });
  return path;
}

// A value with the shape the template asks for. The script's own rule is negative (it
// rejects `@ : / # ? %` and space, which break `DATABASE_URL`), and the colon case below
// pins that rule; 64 hex characters is what a generated secret looks like.
const PASSWORD = "0123456789abcdef".repeat(4);
// Distinctive enough that finding it in any output means it was echoed.
const API_KEY = "sk-deploy-validator-no-echo-9f2c";

/** The variables that make `--check` report no problem at all. */
const completeEnv = (overrides: Record<string, string | null> = {}): Record<string, string | null> => ({
  VERSION: "0.1.0",
  POSTGRES_PASSWORD: PASSWORD,
  REGISTRY: "ghcr.io/agentdocumentor",
  CHAT_API_KEY: API_KEY,
  ...overrides,
});

test("--check on a missing env file fails, names it, and creates nothing", { skip }, (t) => {
  const dir = scratchDir(t, "deploy-script-missing-");
  const envPath = join(dir, ".env.prod");

  const result = run(["--check", "--env-file", envPath]);

  assert.equal(result.status, 1, `a missing env file must fail validation: ${result.stderr}`);
  assert.ok(
    result.stderr.includes(`${envPath} does not exist`),
    `the message must name the file it looked for: ${result.stderr}`,
  );
  assert.ok(
    result.stderr.includes("deploy/env.prod.example"),
    `the message must point at the template to copy: ${result.stderr}`,
  );
  // `--check` touches nothing: deploy mode copies the template here, check mode must not.
  assert.equal(existsSync(envPath), false, "--check created the env file it was told to validate");
});

test("--check on a complete env passes and reaches no docker command", { skip }, (t) => {
  const envPath = writeEnvFile(t, completeEnv());

  const result = run(["--check", "--env-file", envPath]);

  assert.equal(result.status, 0, `a complete env must pass: ${result.stderr}`);
  assert.match(result.stdout, /check: OK/);
  assert.ok(
    result.stdout.includes("up -d --wait"),
    `the dry run must print the command it would run: ${result.stdout}`,
  );
  // The first line deploy mode prints, before `docker compose pull`: absent here means no
  // deployment step ran. A `--check` that quietly deployed would still exit 0 otherwise.
  assert.doesNotMatch(result.stdout, /==> pulling/, "--check reached the pull step");
  assert.doesNotMatch(result.stderr, /==> pulling/, "--check reached the pull step");
  assert.match(result.stdout, /nothing was pulled, started or written/);
});

test("a missing CHAT_API_KEY is a failure that names it", { skip }, (t) => {
  const envPath = writeEnvFile(t, completeEnv({ CHAT_API_KEY: null }));

  const result = run(["--check", "--env-file", envPath]);

  assert.equal(result.status, 1, "a stack that fails every turn must not deploy");
  assert.match(result.stderr, /CHAT_API_KEY is not set/);
});

test("POSTGRES_PASSWORD with a colon fails and the value is never printed", { skip }, (t) => {
  const colonPassword = "aa:bb-deploy-validator-colon";
  const envPath = writeEnvFile(t, completeEnv({ POSTGRES_PASSWORD: colonPassword }));

  const result = run(["--check", "--env-file", envPath]);

  assert.equal(result.status, 1, "a password that breaks DATABASE_URL must not reach initdb");
  assert.match(result.stderr, /POSTGRES_PASSWORD contains a character/);
  assert.ok(result.stderr.includes("DATABASE_URL"), "the message must say what it breaks");
  // Naming the offending character class is the fix; printing the value is a leak.
  assert.equal(
    result.stdout.includes(colonPassword) || result.stderr.includes(colonPassword),
    false,
    "the rejected password was echoed back",
  );
});

test("an empty VERSION is a failure that names it", { skip }, (t) => {
  const envPath = writeEnvFile(t, completeEnv({ VERSION: "" }));

  const result = run(["--check", "--env-file", envPath]);

  assert.equal(result.status, 1, "the compose file has no default tag, so an empty VERSION cannot deploy");
  assert.match(result.stderr, /VERSION is not set/);
});

test("an unknown argument is a usage error, not a validation failure", { skip }, (t) => {
  const envPath = writeEnvFile(t, completeEnv());

  const result = run(["--env-file", envPath, "--nope"]);

  // Exit 2 is the script's usage status; it must be distinguishable from a failed
  // validation (1), or a wrapper script would retry a typo as if the env were broken.
  assert.equal(result.status, 2, `an unknown flag must exit 2: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /error: unknown argument: --nope/);
  assert.match(result.stderr, /Usage: \.\/scripts\/deploy\.sh/);
  // Usage goes to stderr and nothing is validated, so stdout stays empty.
  assert.equal(result.stdout, "", "a usage error must not report a verdict on stdout");
});

test("no secret from a complete env appears in the output", { skip }, (t) => {
  const envPath = writeEnvFile(t, completeEnv());

  const result = run(["--check", "--env-file", envPath]);
  const output = `${result.stdout}${result.stderr}`;

  // The passing case is the one that prints the most: images, registry, version. Neither
  // secret may be among them — `DATABASE_URL` is assembled from POSTGRES_PASSWORD, so an
  // echoed password is a working database credential in the operator's terminal history.
  assert.equal(result.status, 0, `expected a passing check: ${result.stderr}`);
  assert.equal(output.includes(API_KEY), false, "CHAT_API_KEY was echoed");
  assert.equal(output.includes(PASSWORD), false, "POSTGRES_PASSWORD was echoed");
});
