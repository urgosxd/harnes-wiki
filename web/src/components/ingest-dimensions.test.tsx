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
 *   - one row per dimension, with that dimension's OWN name, status and summary (S2);
 *   - the two fixed sections survive untouched for jobs carrying no usable array (S3);
 *   - the fixed sections do not ALSO render when the array does, so no row is shown
 *     twice for the same job (S4);
 *   - nothing in the array can throw or invent a value, and an unusable array falls back
 *     to the fixed pair (S5);
 *   - a dimension's badge is its own, not the job's overall status (S6).
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

describe("IngestJobView: no duplicated rows (S4)", () => {
  it("does not render the two fixed sections beside the dimensions", () => {
    const { container } = render(<IngestJobView job={TWO_DIMENSIONS} />);

    // The rows exist…
    expect(rows()).toHaveLength(2);
    // …and the hardcoded columns are gone for this job, in structure AND in role:
    // a `section` with `aria-label="Ingest"` is a region named after a dimension the
    // payload did not necessarily contain.
    expect(screen.queryByTestId("dimension-ingest")).toBeNull();
    expect(screen.queryByTestId("dimension-compile")).toBeNull();
    expect(screen.queryByRole("region", { name: "Ingest" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Compile" })).toBeNull();
    expect(container.querySelectorAll(".job__dimensions > .dimension")).toHaveLength(2);
    // No stage rows either: they belong to the fixed columns, which did not render.
    expect(screen.queryAllByTestId("stage")).toHaveLength(0);
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
    expect(screen.queryByTestId("dimension-ingest")).toBeNull();
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
