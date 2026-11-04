import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The CI gate's own contract, asserted as text.
 *
 * A pipeline is the one artefact in a repository that nothing else tests: it runs
 * elsewhere, on a machine no test can see, so a wrong path or a stray command survives
 * review and fails every later build. These assertions are cheap and they pin the three
 * things that actually went wrong while this gate was being built.
 *
 * They run wherever the repository exists on disk; in a container built from the image
 * there is no checkout above `test/`, so they skip rather than pretend.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "ci.sh");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const inCheckout = existsSync(SCRIPT_PATH) && existsSync(WORKFLOW_PATH);
const skip = inCheckout ? false : "needs the repository checkout (an image has no repository above test/)";

const script = inCheckout ? readFileSync(SCRIPT_PATH, "utf8") : "";
const workflow = inCheckout ? readFileSync(WORKFLOW_PATH, "utf8") : "";

/**
 * The YAML without its comments.
 *
 * Assertions here are about CONFIGURATION, not prose: the file explains in a comment why
 * it carries no `continue-on-error`, and a naive text check would fail on the explanation
 * rather than on the setting. Stripping comments first is what makes the test about the
 * thing it claims to test.
 */
const configuration = (yaml: string): string =>
  yaml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

const runSteps = (yaml: string): string[] =>
  [...yaml.matchAll(/^\s*(?:-\s*)?run:\s*(.+)$/gm)].map((match) => (match[1] ?? "").trim());

test("the workflow runs the script and no command of its own", { skip }, () => {
  // One command: the gate must be reproducible with `bash scripts/ci.sh`, so nothing in
  // the YAML may exist only in CI.
  assert.deepEqual(runSteps(configuration(workflow)), ["bash scripts/ci.sh"]);
  assert.doesNotMatch(configuration(workflow), /continue-on-error|\|\|\s*true/);
});

test("the script never hardcodes a Docker name derived from the checkout directory", { skip }, () => {
  // Docker derives the compose project — and therefore its network — from the directory
  // holding docker-compose.yml: `AgentDocumentor` here, the repository's name under
  // actions/checkout. A literal `*_internal` works on exactly one checkout and then
  // reports "no database answered" on every CI run, blaming the database for a path bug.
  assert.doesNotMatch(script, /[A-Za-z0-9_-]+_internal/);
  assert.match(script, /COMPOSE_PROJECT_NAME/);
});

test("the database tier is required, and the suite is mounted rather than baked", { skip }, () => {
  assert.match(script, /CI_REQUIRE_DATABASE=1/);
  assert.match(script, /test:\/app\/test:ro/);
  // The image deliberately carries no tests, so a test that only ever runs from the
  // image would prove nothing about the checked-out suite.
  assert.match(readFileSync(join(REPO_ROOT, "server", ".dockerignore"), "utf8"), /^test$/m);
});

test("neither image has its test stage as the default target", { skip }, () => {
  for (const file of ["server/Dockerfile", "web/Dockerfile"]) {
    const stages = [
      ...readFileSync(join(REPO_ROOT, file), "utf8").matchAll(/^FROM\s+\S+(?:\s+AS\s+(\S+))?/gim),
    ].map((match) => (match[1] ?? "").trim());
    assert.ok(stages.includes("test"), `${file}: needs a test stage`);
    assert.notEqual(stages.at(-1), "test", `${file}: the last stage must stay the runtime image`);
  }
});
