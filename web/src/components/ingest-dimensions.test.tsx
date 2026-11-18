import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { IngestJobView } from "./IngestJobView.tsx";
import type { IngestJob } from "../lib/ingest.ts";

/**
 * WHAT THESE TESTS ARE ALLOWED TO CATCH
 *
 * The job payload carries per-dimension results (`wiki`, `kg`, and whatever the producer
 * adds next). The panel used to declare only `ingest` and `compile` and render two fixed
 * sections, so a dimension's own words never reached the screen — and a failed `kg` under
 * a `succeeded` overall status was indistinguishable from success.
 *
 * So the rules pinned here are:
 *
 *   - the two fixed sections render ALWAYS: `ingest`/`compile` are the pipeline's two
 *     state machines, and `dimensions` is a per-output breakdown (S1 of the union);
 *   - one row per dimension, with that dimension's OWN name, status and summary, in
 *     addition to the fixed pair and after it (S2);
 *   - a dimension that merely repeats a fixed row's name is not rendered a second time
 *     (S3);
 *   - the Compile section shows the stage and the progress the payload carries, and
 *     omits a value it does not carry instead of inventing one (S4);
 *   - nothing in the array can throw or invent a value, and no array can blank the fixed
 *     pair (S5);
 *   - a dimension's badge is its own, not the job's overall status (S6).
 *
 * The rule these tests used to pin - "when `dimensions` renders, the two fixed sections
 * are not ALSO rendered" - is SUPERSEDED, and the test that asserted it is inverted below
 * on purpose. A real payload broke it: `compile` was still `running` on `page_generation`
 * while `dimensions` already reported `wiki` and `kg` as `succeeded`, so the array hid the
 * only row that said what the job was doing right now.
 */

function job(overrides: Partial<IngestJob> = {}): IngestJob {
  return {
    id: "ing_01J8Z4Q7X3",
    source: "https://example.com/article",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:12.480Z",
    ingest: { status: "succeeded", stage: "committing", attempts: [] },
    compile: { status: "succeeded", stage: "finalize", progress: null },
    ...overrides,
  };
}

/** The exact payload the requester pasted, with the counts filled in. */
const TWO_DIMENSIONS = job({
  compile: {
    status: "succeeded",
    stage: "finalize",
    progress: null,
    message: "Compiled wiki and kg.",
  },
  dimensions: [
    { name: "wiki", status: "succeeded", summary: "wiki:created" },
    { name: "kg", status: "succeeded", summary: "kg:12 chunks, 3 entities" },
  ],
});

function rows() {
  return screen.queryAllByTestId("dimension-row");
}

describe("IngestJobView: the payload's dimensions (S2)", () => {
  it("renders one row per dimension, with its own name, badge and summary", () => {
    render(<IngestJobView job={TWO_DIMENSIONS} />);

    const rendered = rows();
    expect(rendered).toHaveLength(2);

    // `wiki` arrives first in the payload and stays first: the producer's order is
    // the pipeline's own order, and sorting it here would invent a ranking.
    expect(rendered[0]?.getAttribute("data-dimension")).toBe("wiki");
    expect(rendered[0]?.textContent).toContain("wiki");
    expect(rendered[0]?.querySelector(".badge")?.getAttribute("data-status")).toBe("succeeded");
    expect(rendered[0]?.textContent).toContain("wiki:created");

    expect(rendered[1]?.getAttribute("data-dimension")).toBe("kg");
    expect(rendered[1]?.textContent).toContain("kg");
    expect(rendered[1]?.querySelector(".badge")?.getAttribute("data-status")).toBe("succeeded");
    expect(rendered[1]?.textContent).toContain("kg:12 chunks, 3 entities");
  });

  it("renders a dimension it has never heard of exactly like one it has", () => {
    // No fixed names: the panel has no list of dimensions to recognise, so `qa` must
    // render through the same path as `wiki` instead of being hidden as unknown.
    render(
      <IngestJobView
        job={job({
          dimensions: [
            { name: "qa", status: "failed", summary: "qa: 2 findings" },
          ],
        })}
      />,
    );

    const rendered = rows();
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.textContent).toContain("qa");
    expect(rendered[0]?.querySelector(".badge")?.getAttribute("data-status")).toBe("failed");
    expect(rendered[0]?.textContent).toContain("qa: 2 findings");
  });

  it("renders a row for a dimension whose payload carries no summary", () => {
    // A missing summary is an absent fact, not an empty one: the row is shown with its
    // name and badge and no summary line, rather than a blank <p> or the word "null".
    render(
      <IngestJobView job={job({ dimensions: [{ name: "wiki", status: "succeeded" }] })} />,
    );

    const rendered = rows();
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.textContent).toContain("wiki");
    expect(screen.queryByTestId("dimension-summary")).toBeNull();
  });

  it("keeps the row and drops only an unusable summary", () => {
    // The summary is the one field a row can live without, so a non-string there does
    // not justify hiding a dimension whose name and status are perfectly readable.
    render(
      <IngestJobView
        job={job({ dimensions: [{ name: "kg", status: "succeeded", summary: 42 }] })}
      />,
    );

    const rendered = rows();
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.textContent).toContain("kg");
    expect(rendered[0]?.textContent).not.toContain("42");
    expect(screen.queryByTestId("dimension-summary")).toBeNull();
  });
});

/**
 * The exact job the requester pasted: the ingest closed, the compile still running on
 * `page_generation` at 0 of 43 pages, and both reported dimensions already `succeeded`.
 *
 * This is the payload the superseded rule mangled: the array was non-empty, so the two
 * fixed sections were dropped and the panel showed two green rows for a job that was
 * still working.
 */
const USER_PAYLOAD = job({
  id: "ing_01M7RDTQ37RE057Z4JZB1ZFCKW",
  updatedAt: "2026-11-18T22:54:30.000Z",
  ingest: {
    status: "succeeded",
    stage: "journaling",
    endedAt: "2026-11-18T22:54:28.000Z",
    message: "Source ingested.",
    attempts: [
      { attempt: 1, startedAt: "2026-11-18T22:54:20.000Z", endedAt: "2026-11-18T22:54:28.000Z" },
    ],
  },
  compile: {
    status: "running",
    stage: "page_generation",
    progress: { completed: 0, total: 43 },
  },
  dimensions: [
    { name: "wiki", status: "succeeded", summary: "wiki:created" },
    { name: "kg", status: "succeeded", summary: "kg:6 chunks, 154 entities" },
  ],
});

describe("IngestJobView: the fixed pair and the dimensions are one union (S1, S2)", () => {
  /**
   * THE INVERTED TEST.
   *
   * This used to assert "does not render the two fixed sections beside the dimensions"
   * (S4 of `odd/tasks/ingest-dimensions-array.md`). That spec is SUPERSEDED, not broken:
   * the array is a per-output breakdown and the fixed pair is the job's two state
   * machines, so the fixed sections must render whether or not the array does. The
   * assertions are the old ones, reversed one by one.
   */
  it("renders the two fixed sections beside the dimensions", () => {
    const { container } = render(<IngestJobView job={TWO_DIMENSIONS} />);

    // The rows exist…
    expect(rows()).toHaveLength(2);
    // …and the two fixed columns are there with them, in structure and in role.
    expect(screen.getByTestId("dimension-ingest")).toBeDefined();
    expect(screen.getByTestId("dimension-compile")).toBeDefined();
    expect(screen.getByRole("region", { name: "Ingest" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Compile" })).toBeDefined();
    expect(container.querySelectorAll(".job__dimensions > .dimension")).toHaveLength(4);
    // Both stage rows are rendered: they belong to the fixed columns, which always render.
    expect(screen.getAllByTestId("stage")).toHaveLength(2);
  });

  it("renders all four rows of the requester's job, the running compile among them", () => {
    const { container } = render(<IngestJobView job={USER_PAYLOAD} />);

    const sections = [
      ...container.querySelectorAll<HTMLElement>(".job__dimensions > .dimension"),
    ];
    // Four rows, together. The old rule produced two of them, and the two it dropped
    // were the only ones that said what the job was doing.
    expect(sections).toHaveLength(4);

    // The fixed pair first, in its own order…
    expect(sections[0]?.getAttribute("aria-label")).toBe("Ingest");
    expect(sections[1]?.getAttribute("aria-label")).toBe("Compile");
    // …then the payload's breakdown rows, after them, in the producer's order.
    expect(sections[2]?.getAttribute("data-dimension")).toBe("wiki");
    expect(sections[3]?.getAttribute("data-dimension")).toBe("kg");

    // The row that says what is happening RIGHT NOW.
    const compile = screen.getByTestId("dimension-compile");
    expect(compile.textContent).toContain("running");
    // Its stage, as the panel humanises every stage word.
    expect(compile.textContent).toContain("generating pages");
    // The progress the payload carries, as the payload's pair - never a percentage this
    // view computed. `of` is this panel's established separator for that pair.
    expect(compile.textContent).toContain("0 of 43");
    expect(compile.textContent).not.toMatch(/\d+\s*%/);

    // The ingest's own closure and attempts, which the payload did report.
    const ingest = screen.getByTestId("dimension-ingest");
    expect(ingest.textContent).toContain("succeeded");
    expect(ingest.textContent).toContain("Source ingested.");
    expect(ingest.textContent).toContain("2026-11-18T22:54:28.000Z");
    expect(ingest.textContent).toContain("done");

    // And the breakdown rows still carry their own words.
    expect(rows().map((row) => row.getAttribute("data-dimension"))).toEqual(["wiki", "kg"]);
  });

  it("omits the finished-at line and the attempt list only when the payload carries neither", () => {
    // Absent means absent: no invented timestamp, no "unknown" placeholder.
    render(
      <IngestJobView
        job={job({
          ingest: { status: "running", stage: "committing", attempts: [] },
        })}
      />,
    );

    expect(screen.queryAllByTestId("finished-at")).toHaveLength(0);
  });
});

describe("IngestJobView: a dimension that repeats a fixed row is not shown twice (S3)", () => {
  it("does not render an `ingest` or `compile` dimension as its own row", () => {
    render(
      <IngestJobView
        job={job({
          dimensions: [
            { name: "Ingest", status: "succeeded" },
            { name: "  COMPILE ", status: "running" },
            { name: "compile", status: "succeeded" },
            { name: "wiki", status: "succeeded", summary: "wiki:created" },
          ],
        })}
      />,
    );

    // Case, surrounding whitespace and repetition change nothing: the fixed section
    // already carries that row, and the job is shown once.
    expect(rows().map((row) => row.getAttribute("data-dimension"))).toEqual(["wiki"]);
    // Both fixed sections render, exactly once each.
    expect(screen.getAllByTestId("dimension-ingest")).toHaveLength(1);
    expect(screen.getAllByTestId("dimension-compile")).toHaveLength(1);
    expect(screen.getAllByTestId("stage")).toHaveLength(2);
  });
});

describe("IngestJobView: the fallback is exactly today's render (S3)", () => {
  it("renders the two fixed sections, same labels, same testids, when there is no dimensions array", () => {
    const { container } = render(
      <IngestJobView
        job={job({
          ingest: { status: "running", stage: "committing", attempts: [] },
          compile: { status: "queued", progress: null },
        })}
      />,
    );

    expect(screen.getByTestId("dimension-ingest").textContent).toContain("Ingest");
    expect(screen.getByTestId("dimension-compile").textContent).toContain("Compile");
    expect(screen.getByTestId("dimension-ingest").textContent).toContain("running");
    expect(screen.getByTestId("dimension-compile").textContent).toContain("queued");

    // Exactly two sections, in the same wrapper, with the stage rows and attempt list
    // the old render had. This is the regression guard for every job already on screen.
    expect(container.querySelectorAll(".job__dimensions > .dimension")).toHaveLength(2);
    expect(screen.getAllByTestId("stage")).toHaveLength(2);
    expect(screen.getByText("No attempts yet.")).toBeDefined();
    expect(screen.queryAllByTestId("dimension-row")).toHaveLength(0);
  });
});

describe("IngestJobView: nothing in the payload can throw or be invented (S5)", () => {
  /**
   * Every shape here must fall back to the fixed pair: nothing in it can be rendered as
   * a dimension row without inventing a name or a status.
   */
  const UNUSABLE: Array<[string, unknown]> = [
    ["an empty array", []],
    ["a string instead of an array", "wiki"],
    ["an object instead of an array", { name: "wiki", status: "succeeded" }],
    ["null", null],
    ["a number", 7],
    ["entries that are not objects", [42, null, "wiki", true]],
    ["an entry with no name", [{ status: "succeeded", summary: "wiki:created" }]],
    ["an entry whose name is not a string", [{ name: 42, status: "succeeded" }]],
    ["an entry whose name is blank", [{ name: "   ", status: "succeeded" }]],
    ["an entry with no status", [{ name: "wiki" }]],
    ["an entry whose status is not a string", [{ name: "wiki", status: 200 }]],
    ["an entry whose status is blank", [{ name: "wiki", status: "  " }]],
  ];

  for (const [label, dimensions] of UNUSABLE) {
    it(`falls back to the two fixed sections for ${label}`, () => {
      const { container } = render(<IngestJobView job={job({ dimensions })} />);

      expect(rows()).toHaveLength(0);
      expect(screen.getByTestId("dimension-ingest")).toBeDefined();
      expect(screen.getByTestId("dimension-compile")).toBeDefined();
      expect(container.querySelectorAll(".job__dimensions > .dimension")).toHaveLength(2);
    });
  }

  it("renders the usable entries and skips only the unusable ones", () => {
    // Tolerance is per entry, not all-or-nothing: one broken row must not hide the two
    // dimensions the producer did report.
    render(
      <IngestJobView
        job={job({
          dimensions: [
            42,
            { name: "wiki", status: "succeeded", summary: "wiki:created" },
            { status: "failed" },
            null,
            { name: "kg", status: "succeeded", summary: "kg:12 chunks, 3 entities" },
          ],
        })}
      />,
    );

    const rendered = rows();
    expect(rendered.map((row) => row.getAttribute("data-dimension"))).toEqual(["wiki", "kg"]);
    // A partly broken array drops only the broken entries: it can never take the fixed
    // pair with it.
    expect(screen.getByTestId("dimension-ingest")).toBeDefined();
    expect(screen.getByTestId("dimension-compile")).toBeDefined();
  });
});

describe("IngestJobView: a dimension's badge is its own (S6)", () => {
  it("shows a failed kg as failed under a succeeded overall compile", () => {
    // The reason this feature exists: overall success plus a failed dimension used to
    // be indistinguishable from plain success.
    const { container } = render(
      <IngestJobView
        job={job({
          compile: {
            status: "succeeded",
            stage: "finalize",
            progress: null,
            message: "Compiled wiki and kg.",
          },
          dimensions: [
            { name: "wiki", status: "succeeded", summary: "wiki:created" },
            { name: "kg", status: "failed", summary: "kg: provider refused the batch" },
          ],
        })}
      />,
    );

    const kg = container.querySelector('[data-dimension="kg"]') as HTMLElement | null;
    expect(kg).not.toBeNull();
    const kgBadge = kg?.querySelector(".badge") as HTMLElement | null;
    expect(kgBadge?.getAttribute("data-status")).toBe("failed");
    // The word AND the tone: colour is never the only channel, and the badge carries the
    // dimension's own status rather than the compile's `succeeded`.
    expect(kgBadge?.textContent).toBe("failed");
    expect(kgBadge?.className).toMatch(/badge--bad/);
    expect(kg?.textContent).toContain("kg: provider refused the batch");

    // And the healthy dimension beside it is still painted as the success it is.
    const wiki = container.querySelector('[data-dimension="wiki"]') as HTMLElement | null;
    expect(wiki?.querySelector(".badge")?.className).toMatch(/badge--good/);
  });

  it("shows a running dimension as running under a succeeded overall compile", () => {
    // Not only failures: a dimension that has not finished says so even when the job's
    // own statuses already read terminal.
    render(
      <IngestJobView
        job={job({
          dimensions: [
            { name: "wiki", status: "succeeded" },
            { name: "embeddings", status: "running" },
          ],
        })}
      />,
    );

    const statuses = rows().map((row) => row.querySelector(".badge")?.getAttribute("data-status"));
    expect(statuses).toEqual(["succeeded", "running"]);
  });
});
