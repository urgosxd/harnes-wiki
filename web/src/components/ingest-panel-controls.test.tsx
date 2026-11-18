import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IngestJobsPanel } from "./IngestJobsPanel.tsx";
import type { IngestJob } from "../lib/ingest.ts";
import type { UseIngestResult } from "../lib/use-ingest.ts";

/**
 * WHY THESE ASSERTIONS
 *
 * The operator controls sit on a surface that could easily become convenient instead of
 * true, and two of those temptations are scope decisions, not styling:
 *
 *   - the panel must never pre-judge whether a job may be deleted. A working job is
 *     REFUSED by the host (`409 job_still_working`); deciding locally from the job's own
 *     status would hide the host's answer and invent a policy nobody asked for. So a
 *     running job keeps BOTH controls enabled, and the only thing that disables a row is
 *     that SAME id's request being in flight.
 *   - there is no cancel in this product, at any layer (S7). The upstream service cannot
 *     interrupt a job, so no control, label, `title` or `aria-label` may promise it, and
 *     the panel has to say out loud that a working job is refused rather than stopped.
 *
 * The hint itself is prose, not a control: it says "stopped" on purpose, which is why
 * the scope sweep below reads controls and their labels only, and why the hint's exact
 * sentence has its own assertion.
 */

const STACK_ID = "0f8b1e42-1111-2222-3333-444455556666";

/** A job the LOCAL view knows is still working — the case a `409` is the answer to. */
function runningJob(): IngestJob {
  return {
    id: "job_1",
    source: "https://example.com/a",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ingest: { status: "running", stage: "committing", attempts: [] },
    compile: { status: "running", progress: null },
  };
}

/** The hook's public surface, with the running job on screen and nothing else set. */
function fakeIngest(overrides: Partial<UseIngestResult> = {}): UseIngestResult {
  const active = runningJob();
  return {
    stackId: STACK_ID,
    resolvedStackId: STACK_ID,
    stackIds: [STACK_ID],
    chooseStackId: () => {},
    blockedProblem: null,
    documents: [],
    uploading: false,
    listDocuments: async () => {},
    upload: async () => null,
    removeDocument: async () => {},
    ingestDocument: async () => {},
    documentsNotice: null,
    jobs: [active],
    activeJob: active,
    activeId: active.id,
    loadingList: false,
    listNotice: null,
    pollNotice: null,
    starting: false,
    following: false,
    setListLive: () => {},
    start: async () => {},
    follow: () => {},
    stopFollowing: () => {},
    refreshList: async () => {},
    deleteJob: async () => {},
    retryJob: async () => {},
    deletingIds: new Set<string>(),
    retryingIds: new Set<string>(),
    clearPollNotice: () => {},
    ...overrides,
  };
}

function panel(overrides: Partial<UseIngestResult> = {}) {
  return render(<IngestJobsPanel ingest={fakeIngest(overrides)} onClose={() => {}} />);
}

function deleteButton(): HTMLButtonElement {
  return screen.getByLabelText("Delete job job_1") as HTMLButtonElement;
}

function retryButton(): HTMLButtonElement {
  return screen.getByLabelText("Retry job job_1") as HTMLButtonElement;
}

describe("IngestJobsPanel: the host decides whether a job may be deleted, not the panel", () => {
  it("keeps Delete and Retry enabled on a job that is still working", () => {
    // Nothing here reads the job's status: it is `running` in both dimensions and the
    // controls stay live, because the host's `409 job_still_working` is the authority on
    // whether this job may be deleted — and it is an answer the operator has to read.
    panel();
    expect(deleteButton().disabled).toBe(false);
    expect(retryButton().disabled).toBe(false);
  });

  it("disables the row while THAT id's delete is in flight, and names the request", () => {
    // One click, one request: while the DELETE for this id is out, a second click
    // cannot mean a second delete, and the label says which request is running.
    panel({ deletingIds: new Set(["job_1"]) });
    expect(deleteButton().disabled).toBe(true);
    expect(deleteButton().textContent).toBe("Deleting…");
    // The retry of the same id is refused locally for the same reason: one job, one
    // pending control.
    expect(retryButton().disabled).toBe(true);
  });

  it("leaves the row enabled when a DIFFERENT id is in flight", () => {
    // The in-flight state is per id, never global: another row's delete or retry must
    // not make this job look busy, and must not swallow a legitimate second action.
    panel({ deletingIds: new Set(["job_9"]), retryingIds: new Set(["job_9"]) });
    expect(deleteButton().disabled).toBe(false);
    expect(retryButton().disabled).toBe(false);
    expect(deleteButton().textContent).toBe("Delete");
    expect(retryButton().textContent).toBe("Retry");
  });
});

describe("IngestJobsPanel: nothing on this surface promises to cancel, stop, abort or interrupt", () => {
  it("names no control, label, title or aria-label after an interruption", () => {
    const { container } = panel({ following: true });

    // Controls and their labels only. The hint is prose and is asserted separately; a
    // control is what a user can press, and pressing one must never look like a stop.
    const controls = [
      ...container.querySelectorAll("button, a, input, select, label, [role='button']"),
    ];
    const surfaces = controls.flatMap((element) => [
      element.textContent ?? "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("title") ?? "",
    ]);

    // The sweep has to have something to sweep, or a panel that rendered nothing would
    // pass this by accident.
    expect(controls.length).toBeGreaterThan(5);
    for (const surface of surfaces) {
      expect(surface).not.toMatch(/cancel|stop|abort|interrupt/i);
    }
  });

  it("says that a working job is refused rather than stopped", () => {
    // S7 in words: the operator has to know the refusal is the outcome, not a stall.
    panel();
    expect(
      screen.getByText("A job that is still working is refused, not stopped."),
    ).toBeDefined();
  });
});
