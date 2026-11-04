import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/**
 * The database gate, in both directions.
 *
 * `CI_REQUIRE_DATABASE=1` exists because skipping a whole tier is the honest answer on a
 * laptop and a lie in a gate: with the flag off, an unreachable database removes the
 * Postgres tier from the run and the suite still says pass. Both branches are asserted
 * here — a failure when the flag is set, an honest `false` when it is not — because a
 * flag nobody tests is a comment.
 *
 * The flag is read once at import, so each direction needs its own process.
 */
const dbModule = new URL("./support/db.ts", import.meta.url).href;
const unreachable = "postgres://agentdocumentor:agentdocumentor@127.0.0.1:1/agentdocumentor";

function ask(requireDatabase: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: unreachable };
  if (requireDatabase) env.CI_REQUIRE_DATABASE = "1";
  else delete env.CI_REQUIRE_DATABASE;
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { databaseAvailable } from ${JSON.stringify(dbModule)};\n` +
        'console.log("available:", await databaseAvailable());',
    ],
    { encoding: "utf8", env, timeout: 30_000 },
  );
}

test("CI_REQUIRE_DATABASE=1 turns an unreachable database into a failure", () => {
  const result = ask(true);
  assert.notEqual(result.status, 0, "a gate that skips its database tier is not a gate");
  assert.match(
    String(result.stderr),
    /CI_REQUIRE_DATABASE=1 but no database answered at 127\.0\.0\.1:1\//,
    "the failure must name the flag and the target, without the password",
  );
  assert.doesNotMatch(String(result.stderr), /agentdocumentor:agentdocumentor@/, "never echo the password");
});

test("without the flag an unreachable database is a skip, not a crash", () => {
  const result = ask(false);
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /available: false/);
});
