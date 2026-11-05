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
 * Every other table in the corpus is left alone, and the reason is substantive rather than
 * defensive: those tables have no commit cell. They are decision logs (`# | Decisión |
 * Motivo`), evidence logs (`Fecha | Task | Evidencia`), commit narrations (`Commit |
 * Contenido`) and measurement tables — none records a task's commit, so none can be
 * misread as one. A guard that fails on an unrelated table gets deleted; a guard that
 * reads one as a task row lies.
 */
function taskRows(markdown: string): TaskRow[] {
  return markdown
    .split("\n")
    .filter((line) => /^\|\s*[A-Z]?\d+\s*\|/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 5)
    .map((cells) => ({ id: cells[0] ?? "", commit: cells[4] ?? "" }));
}

/** The header row of every markdown table in a document, in order. */
function tableHeaders(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells, index, all) => {
      // A header row is followed by a separator row of dashes.
      const next = all[index + 1];
      return next !== undefined && next.every((cell) => /^:?-{2,}:?$/.test(cell));
    });
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

    test(`${file}: the rows and the header agree about what is pending`, () => {
      // Both directions, because a mutation test showed the one-directional version was
      // decorative: flipping a committed row back to `pending` under a "complete" header
      // slipped through. A row that says pending and a header that says complete cannot
      // both be true, and neither can a header that says in progress with nothing pending.
      if (rows.length === 0) return;
      const statusLine = /^Status:\s*(.+)$/m.exec(markdown);
      if (!statusLine) return;
      const status = (statusLine[1] ?? "").trim();
      const pendingRows = rows.filter((row) => /pending/i.test(row.commit)).map((row) => row.id);
      if (pendingRows.length > 0) {
        assert.match(
          status,
          /in progress/i,
          `${file}: rows ${pendingRows.join(", ")} read pending, so the header cannot say "${status}"`,
        );
      } else {
        assert.doesNotMatch(
          status,
          /in progress/i,
          `${file}: every task has a commit, so the header cannot say "${status}"`,
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

  test("every task-shaped table is evaluated, so a new shape cannot slip in unread", () => {
    // The rules above only ever read five-column tables. Measured on this corpus, exactly
    // two documents have one (multitenant-stackId.md, 33 rows, and urlparam-stackId.md, 5
    // rows) and the rest contribute nothing — which is fine while it is TRUE and dangerous
    // the moment a table that does record commits appears in a shape the parser skips
    // silently.
    //
    // So: any table whose header names both a task id in front and a commit at the end is
    // a task table, and must be evaluated. The legacy logs escape on the substance — their
    // last column is `Motivo`, `Evidencia` or `Contenido`, and a `Commit | Contenido` log
    // has no task id in front — not on a column count.
    const evaluatedDocuments: string[] = [];
    for (const file of readdirSync(FEATURES_DIR).filter((name) => name.endsWith(".md"))) {
      const markdown = readFileSync(join(FEATURES_DIR, file), "utf8");
      if (taskRows(markdown).length > 0) evaluatedDocuments.push(file);

      for (const header of tableHeaders(markdown)) {
        const first = (header[0] ?? "").toLowerCase();
        const last = (header.at(-1) ?? "").toLowerCase();
        const taskShaped = /^(id|#|task)$/.test(first) && /commit/.test(last);
        if (!taskShaped) continue;
        assert.equal(
          header.length,
          5,
          `${file}: a task table with columns [${header.join(" | ")}] is task-shaped but not ` +
            "evaluated; teach taskRows() about it or the rules silently skip it",
        );
      }
    }

    assert.deepEqual(
      evaluatedDocuments,
      ["multitenant-stackId.md", "urlparam-stackId.md"],
      "two documents carry task rows today; a third one means the rules reach further " +
        "than this list says and the spec must be restated",
    );
  });
} else {
  test("feature documents are checked where the checkout exists", { skip }, () => {
    // Skipped in the image: nothing to read above the mounted test directory.
  });
}
