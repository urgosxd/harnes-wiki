import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The roster is a secret file, and "it is in `.gitignore`" is a claim that has to be
 * checked rather than remembered.
 *
 * Two things are pinned here, and both are the kind that fails silently:
 *
 *  1. `.chat-users` is IGNORED by git and not already tracked. Writing the tokens to a
 *     path someone assumed was ignored is how a secret reaches a commit, and a commit
 *     keeps it after the file is deleted.
 *  2. No document, compose file or deployment template carries a roster VALUE. The
 *     shape (`id:token,id:token`, 32 hex characters) is what documentation is allowed
 *     to show; a real token in an example is a leaked token, because an operator copies
 *     examples.
 *
 * This is a repository-level check, like the other hygiene tests: it reads the checkout
 * where the checkout exists and skips inside the server image, where nothing above the
 * mounted test directory is visible.
 */
const REPO_ROOT =
  process.env.CI_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function git(args: string[]) {
  return spawnSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" });
}

const inCheckout = existsSync(join(REPO_ROOT, ".gitignore"));
const gitWorks = inCheckout && git(["rev-parse", "--git-dir"]).status === 0;
const skip = gitWorks
  ? false
  : "needs the git checkout (the test image mounts a read-only copy at CI_REPO_ROOT)";

/** A roster value: an id, a colon, and 32 hex characters. What a token looks like. */
const ROSTER_VALUE = /\b[A-Za-z0-9._@-]{1,64}:[0-9a-f]{32}\b/;

test(".chat-users is ignored by git, with the rule named", { skip }, () => {
  const result = git(["check-ignore", "-v", ".chat-users"]);

  assert.equal(
    result.status,
    0,
    "`.chat-users` is NOT ignored: writing tokens there would put them in the next commit",
  );
  // The rule is pinned by name, not merely by its effect: `git check-ignore -v` prints
  // `<source>:<line>:<pattern>`, and the pattern is the thing a future edit could drop
  // while every test that only asked "is it ignored" kept passing for another reason.
  assert.match(result.stdout, /^\.gitignore:\d+:\.chat-users\t/m);
});

test(".chat-users is not tracked by git", { skip }, () => {
  const tracked = git(["ls-files", "--error-unmatch", ".chat-users"]);
  assert.notEqual(tracked.status, 0, "`.chat-users` is tracked: a token is already in the history");
});

test("no tracked document, compose file or template carries a roster value", { skip }, () => {
  const candidates = [
    "README.md",
    "docker-compose.yml",
    "docker-compose.prod.yml",
    "server/entrypoint.sh",
    "deploy/env.prod.example",
    ...readdirSync(join(REPO_ROOT, "odd", "tasks")).map((name) => join("odd", "tasks", name)),
  ].filter((relative) => existsSync(join(REPO_ROOT, relative)));

  const offenders = candidates.filter((relative) =>
    ROSTER_VALUE.test(readFileSync(join(REPO_ROOT, relative), "utf8")),
  );

  assert.deepEqual(
    offenders,
    [],
    `these files contain something shaped like a real roster token: ${offenders.join(", ")}; ` +
      "document the shape and put the value in `.chat-users`",
  );
});

test("the compose files read the roster from the environment, never from a literal", { skip }, () => {
  for (const file of ["docker-compose.yml", "docker-compose.prod.yml"]) {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    // `CHAT_USERS: ${CHAT_USERS:-...}` — interpolated, so the value lives outside the
    // file. A literal after `CHAT_USERS:` is a committed roster.
    const assignment = /^\s*CHAT_USERS:\s*(.*)$/m.exec(text);
    assert.ok(assignment, `${file} does not mention CHAT_USERS`);
    assert.match(
      assignment[1]!.trim(),
      /^\$\{CHAT_USERS(:-[^}]*)?\}$/,
      `${file} sets CHAT_USERS to something other than an interpolation`,
    );
  }
});
