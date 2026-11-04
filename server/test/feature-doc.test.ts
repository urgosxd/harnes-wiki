import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The feature documents must not contradict their own commits.
 *
 * Twice now a reconciliation was promised in a commit message and did not land: a task
 * table that still said `pending` beside a commit that closed it, and a header that still
 * said `in progress` when every row had a commit. A reader trusts the table; a table that
 * lies about the work is worse than no table, because it isbelieved.
 *
 * So this is a test, not another promise. It reads every feature document in
 * `odd/tasks/` and checks the two things that actually drifted:
 *
 *  1. a row whose commit cell names a SHA is no longer `pending`;
 *  2. a document with no `pending` row is not still marked `Status: in progress`.
 *
 * It runs where the repository exists (a laptop, CI); inside the server image there is no
 * `odd/` above the mounted tests, so it skips rather than pretending.
 */
// `CI_REPO_ROOT` lets the CI container point at a read-only mount of the checkout, so a
// guard about repository files RUNS in CI instead of skipping for lack of them.
const REPO_ROOT =
  process.env.CI_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FEATURES_DIR = join(REPO_ROOT, "odd", "tasks");
const inCheckout = existsSync(FEATURES_DIR);
const skip = inCheckout ? false : "needs the repository checkout (the features live in odd/tasks)";

interface TaskRow {
  id: string;
  /** The commit cell: a SHA, `pending`, or a word like `withdrawn`. */
  commit: string;
}

/**
 * Task rows: the five-column table this project writes its features in
 * (`| ID | Task | Spec | Route | Commit |`).
 *
 * A row with a different column count is not one of these tables — an older document may
 * use a four-column table or plain bullets — and is left alone rather than read as if its
 * last cell were a commit. A guard that misreads an unrelated document into a failure is
 * a guard nobody keeps.
 */
function taskRows(markdown: string): TaskRow[] {
  return markdown
    .split("\n")
    .filter((line) => /^\|\s*[A-Z]?\d+\s*\|/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 5)
    .map((cells) => ({ id: cells[0] ?? "", commit: cells[4] ?? "" }));
}

/** A commit cell "names a commit" when it contains a hex SHA of at least 7 characters. */
function namesCommit(cell: string): boolean {
  return /\b[0-9a-f]{7,40}\b/.test(cell);
}

if (inCheckout) {
  for (const file of readdirSync(FEATURES_DIR).filter((name) => name.endsWith(".md"))) {
    const markdown = readFileSync(join(FEATURES_DIR, file), "utf8");
    const rows = taskRows(markdown);

    test(`${file}: no task with a commit is still pending`, () => {
      const lying = rows.filter((row) => namesCommit(row.commit) && /pending/i.test(row.commit));
      assert.deepEqual(
        lying.map((row) => `${row.id} (commit ${row.commit})`),
        [],
        "a row that names its commit cannot still read pending",
      );
    });

    test(`${file}: a document with no pending task is not still in progress`, () => {
      if (rows.length === 0) return;
      const open = rows.filter((row) => /pending/i.test(row.commit));
      const statusLine = /^Status:\s*(.+)$/m.exec(markdown);
      if (!statusLine) return;
      const status = (statusLine[1] ?? "").trim();
      if (open.length === 0) {
        assert.doesNotMatch(
          status,
          /in progress/i,
          `every task has a commit, so the header cannot say "${status}"`,
        );
      }
    });
  }

  test("the reconciled feature document is actually in that set", () => {
    // A guard that silently reads no file is the failure mode this test exists for.
    assert.ok(
      existsSync(join(FEATURES_DIR, "multitenant-stackId.md")),
      "multitenant-stackId.md must exist for these rules to mean anything",
    );
  });
} else {
  test("feature documents are checked where the checkout exists", { skip }, () => {
    // Skipped in the image: nothing to read above the mounted test directory.
  });
}
