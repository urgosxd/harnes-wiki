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
 * The same reader is also the census: which documents carry task rows is DECLARED, not
 * inferred, and every document a task table appears in must carry the sections that make
 * its rows legible — `## Specs` to cite and `## Log` to read. Those structural rules are
 * pure functions over document text so they can be exercised on malformed input as well
 * as on the corpus: a guard nobody has ever seen fail is not a guard.
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
  /** The spec cell: what the row claims to implement, e.g. `S2-S5, S11, S12`. */
  spec: string;
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
    .map((cells) => ({ id: cells[0] ?? "", spec: cells[2] ?? "", commit: cells[4] ?? "" }));
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

/**
 * The body of a `## <heading>` section: the lines under it up to the next `##` heading, or
 * `null` when the document has no such heading. Section-scoped rather than a bare search of
 * the whole file, because `S21` is both a spec heading in one document and a word inside
 * another document's log; a whole-file search cannot tell a declaration from a mention.
 */
function sectionBody(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\s*$`).test(line));
  if (at < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^##\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

/**
 * The specs a document DECLARES: a line in `## Specs` that opens with `S<n>` and then a
 * `.`, a space or a `(`. Measured on this corpus the entries are written `S1. …`,
 * `S8 (unit 2, …)` and `S11 (transport). …`, so an `S<n>.`-only rule would silently miss
 * S8 and S11-S23 while their task rows cite them — a decorative check wearing a strict
 * check's clothes. Returns `null` when there is no `## Specs` section at all, which is a
 * different fact from an empty one.
 */
function declaredSpecs(markdown: string): Set<number> | null {
  const body = sectionBody(markdown, "Specs");
  if (body === null) return null;
  return new Set([...body.matchAll(/^S(\d+)[.\s(]/gm)].map((match) => Number(match[1])));
}

/**
 * The specs a task row's Spec cell cites. Two shapes appear in the corpus and both must be
 * read or the check is decorative: `S2-S5, S11, S12` (a range beside singles) and
 * `S15 (F1)`, `S1 / D5`, `S20 (NET-KEY)` (a spec with a decision or finding tag beside it).
 * `D…` tokens are decisions, not specs, so they are not resolved against `## Specs`.
 */
const SPEC_RANGE = /\bS(\d+)\s*[-–—]\s*S(\d+)\b/g;
const SPEC_SINGLE = /\bS(\d+)\b/g;

function citedSpecs(cell: string): number[] {
  const cited = new Set<number>();
  for (const match of cell.matchAll(SPEC_RANGE)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    for (let n = Math.min(from, to); n <= Math.max(from, to); n += 1) cited.add(n);
  }
  for (const match of cell.matchAll(SPEC_SINGLE)) cited.add(Number(match[1]));
  return [...cited].sort((a, b) => a - b);
}

/**
 * Documents written before this project settled on `## Specs` + `## Log`, and which carry no
 * task rows at all — so the structural rules scoped to task rows do not reach them. They are
 * left untouched on purpose: rewriting a completed feature's record to fit a convention it
 * predates is how history gets edited into agreement, and the census below is what stops
 * this list from becoming a place rules quietly go to die.
 *
 *  - `pi-chat-mvp.md`: the first feature. Requirements sit in `## Decisions already locked`
 *    and `## Non-goals`; the record is `## Evidence log` with SHAs inside prose.
 *  - `invite-link-auth.md`: Spanish headings — `## Decisiones`, `## Evidence log`,
 *    `## Commits`. No spec numbering at all.
 *  - `multiarch-images.md`: same shape, plus measurement sections written before the build.
 *  - `open-identity.md`: same shape: a decision log and an evidence log.
 */
const LEGACY_WITHOUT_SPECS_OR_LOG = [
  "invite-link-auth.md",
  "multiarch-images.md",
  "open-identity.md",
  "pi-chat-mvp.md",
];

/**
 * A document that satisfies every rule, used as the base the malformed cases are cut from.
 * Kept beside `validateFeatureDoc` so a new rule forces a decision here: either the fixture
 * grows a section or the new rule is genuinely not part of "well formed".
 */
const WELL_FORMED_DOC = `# Feature: sample

One line about the sample.
Status: in progress

## Specs

S1. The first rule.
S2. The second rule.
S3. The third rule.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Do the first thing | S1-S2 | inline | pending |

## Log

L1 (request): do the first thing.
`;

/**
 * Every structural rule a feature document must satisfy, as violation strings — empty means
 * valid. Pure over document text, which is what lets the malformed cases below exist without
 * committing a broken document to `odd/tasks/`.
 *
 * The rules that depend on a task table are scoped to documents that actually carry task
 * ROWS rather than exempted by name: a document with no rows cites no specs, so demanding
 * `## Specs` of it would fail on documents that were written before the convention and are
 * not mine to rewrite. A task table in a shape `taskRows()` cannot read is caught separately,
 * by the census, which fails on any task-shaped header that is not five columns.
 */
export function validateFeatureDoc(name: string, markdown: string): string[] {
  const violations: string[] = [];

  if (!/^#\s+Feature:\s*\S+/m.test(markdown)) {
    violations.push(`${name}: no \`# Feature: <name>\` header line`);
  }

  if (sectionBody(markdown, "Tasks") === null) {
    violations.push(`${name}: no \`## Tasks\` section`);
    // Every remaining rule reads task rows. Saying so once beats five derived complaints.
    return violations;
  }

  const rows = taskRows(markdown);
  if (rows.length === 0) return violations;

  const specs = declaredSpecs(markdown);
  if (specs === null) {
    violations.push(`${name}: carries task rows but has no \`## Specs\` section`);
  } else if (specs.size === 0) {
    violations.push(`${name}: \`## Specs\` declares no \`S<n>.\` entry`);
  }

  if (sectionBody(markdown, "Log") === null) {
    violations.push(`${name}: carries task rows but has no \`## Log\` section`);
  }

  if (specs !== null && specs.size > 0) {
    for (const row of rows) {
      for (const cited of citedSpecs(row.spec)) {
        if (specs.has(cited)) continue;
        violations.push(
          `${name}: row ${row.id} cites S${cited} in its Spec cell, which \`## Specs\` does not declare`,
        );
      }
    }
  }

  return violations;
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
    // two documents have one (multitenant-stackId.md, 33 rows, and ui-improve.md, 4 rows)
    // and the other four contribute nothing — which is fine while it is TRUE and dangerous
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

    // The set is DECLARED, not counted: every document that carries task rows is written
    // out below. That is what keeps the original protection while a second such document
    // exists. A count of one was never the protection — it was the measurement of the
    // corpus when the sentinel was written, and a third document arriving unread is the
    // failure mode, not the number two. So a document that starts carrying task rows
    // fails here and must be added deliberately, and one that stops carrying them fails
    // too. Widening this to "any number is fine" would delete the protection instead of
    // restating it.
    assert.deepEqual(
      // Sorted because readdir order is not alphabetical and this comparison is about the
      // set, not the order the filesystem happens to return.
      evaluatedDocuments.sort(),
      ["multitenant-stackId.md", "ui-improve.md"],
      "the documents that carry task rows are declared here, never inferred; a new one " +
        "must be added deliberately so a task table cannot slip in unread",
    );
  });

  test("every feature document satisfies the structural rules it is subject to", () => {
    const violations = readdirSync(FEATURES_DIR)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .flatMap((name) =>
        validateFeatureDoc(name, readFileSync(join(FEATURES_DIR, name), "utf8")),
      );
    assert.deepEqual(violations, []);
  });

  test("the declared legacy exemption is exactly the corpus, in both directions", () => {
    // The exemption is a declaration, not an inference, so it is checked against the
    // measurement rather than trusted. A legacy document that starts carrying specs and a
    // log must come OFF this list, and a new document without them must go ON it — either
    // way the list cannot rot into a place where rules stop applying unnoticed.
    const measured = readdirSync(FEATURES_DIR)
      .filter((name) => name.endsWith(".md"))
      .filter((name) => {
        const markdown = readFileSync(join(FEATURES_DIR, name), "utf8");
        return sectionBody(markdown, "Specs") === null || sectionBody(markdown, "Log") === null;
      })
      .sort();
    assert.deepEqual(measured, LEGACY_WITHOUT_SPECS_OR_LOG);
  });

  test("a well-formed document has no violations, so the malformed cases mean something", () => {
    // Without this, a validator that returned nonsense for everything would pass every
    // negative case below while failing the corpus for reasons nobody reads.
    assert.deepEqual(validateFeatureDoc("sample.md", WELL_FORMED_DOC), []);
  });

  test("a document with no `## Log` is a violation", () => {
    const withoutLog = WELL_FORMED_DOC.replace(/## Log[\s\S]*$/, "");
    assert.deepEqual(validateFeatureDoc("sample.md", withoutLog), [
      "sample.md: carries task rows but has no `## Log` section",
    ]);
  });

  test("a task row citing a spec that `## Specs` does not declare is a violation", () => {
    const citingS9 = WELL_FORMED_DOC.replace("| S1-S2 |", "| S9 |");
    assert.deepEqual(validateFeatureDoc("sample.md", citingS9), [
      "sample.md: row T1 cites S9 in its Spec cell, which `## Specs` does not declare",
    ]);
  });

  test("a document with no `## Tasks` is a violation", () => {
    const withoutTasks = WELL_FORMED_DOC.replace(/## Tasks[\s\S]*?(?=## Log)/, "");
    assert.deepEqual(validateFeatureDoc("sample.md", withoutTasks), [
      "sample.md: no `## Tasks` section",
    ]);
  });
} else {
  test("feature documents are checked where the checkout exists", { skip }, () => {
    // Skipped in the image: nothing to read above the mounted test directory.
  });
}
