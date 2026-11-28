import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IngestJobView } from "./IngestJobView.tsx";
import { IngestJobsPanel } from "./IngestJobsPanel.tsx";
import { ApiClient, ApiError, type DocumentIngestState, type ListedDocument } from "../lib/api.ts";
import {
  MISSING_STACK_ID_PROBLEM,
  noticeFor,
  noticeForOutcome,
  UNRESOLVED_STACK_ID_NOTICE,
  useIngest,
  type UseIngestResult,
} from "../lib/use-ingest.ts";
import type { IngestJob } from "../lib/ingest.ts";

/**
 * WHAT THESE TESTS ARE ALLOWED TO CATCH
 *
 * Each one fails if the UI starts being convenient instead of true:
 *
 *   - one status instead of two columns;
 *   - a percentage invented from a `null` progress;
 *   - `busy` rendered as a failure;
 *   - `unchanged` rendered as `succeeded`;
 *   - an in-flight attempt hidden, or a rolled-back one shown as done;
 *   - `503` displayed as `404` (or worse, as "job failed").
 */

function job(overrides: Partial<IngestJob> = {}): IngestJob {
  return {
    id: "ing_01J8Z4Q7X3",
    source: "https://example.com/article",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:12.480Z",
    ingest: { status: "running", stage: "committing", attempts: [] },
    compile: { status: "queued", progress: null },
    ...overrides,
  };
}

describe("IngestJobView: two dimensions", () => {
  it("renders an ingest column and a compile column, not one status", () => {
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "running", stage: "page_generation", progress: null },
        })}
      />,
    );

    const ingestColumn = screen.getByTestId("dimension-ingest");
    const compileColumn = screen.getByTestId("dimension-compile");

    // The whole point: one finished and one running, side by side, with the
    // finished one marked settled and the running one not.
    expect(ingestColumn.textContent).toContain("succeeded");
    expect(compileColumn.textContent).toContain("running");
    expect(document.querySelector('[data-status="succeeded"]')?.getAttribute("data-settled")).toBe(
      "true",
    );
    expect(document.querySelector('[data-status="running"]')?.getAttribute("data-settled")).toBe(
      "false",
    );
  });

  it("shows the real stage name of each dimension", () => {
    render(
      <IngestJobView
        job={job({
          ingest: { status: "running", stage: "committing", attempts: [] },
          compile: { status: "running", stage: "detect_changes", progress: null },
        })}
      />,
    );

    expect(screen.getByTestId("dimension-ingest").textContent).toContain("committing");
    expect(screen.getByTestId("dimension-compile").textContent).toContain("detecting changes");
  });

  it("says 'waiting' instead of leaving an absent stage blank", () => {
    render(
      <IngestJobView
        job={job({
          ingest: { status: "queued", attempts: [] },
          compile: { status: "queued", progress: null },
        })}
      />,
    );
    expect(screen.getAllByTestId("stage").map((node) => node.textContent)).toEqual([
      "waiting",
      "waiting",
    ]);
  });
});

describe("IngestJobView: progress is never invented", () => {
  it("shows an indeterminate indicator when progress is null", () => {
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "running", stage: "extraction", progress: null },
        })}
      />,
    );

    expect(screen.getByTestId("progress-indeterminate")).toBeDefined();
    // No progressbar role at all: there is no number to expose to assistive tech.
    expect(screen.queryByRole("progressbar")).toBeNull();
    // And no percentage anywhere in the compile column.
    expect(screen.getByTestId("dimension-compile").textContent).not.toMatch(/\d+\s*%/);
    expect(screen.getByTestId("dimension-compile").textContent).toMatch(/does not report a total/);
  });

  it("shows NO indicator once the compile has settled, even with progress null", () => {
    // The root of a real defect: `skipped` and `failed` also carry `progress: null`,
    // so a bar keyed on null alone animated "Working" for a compile that had already
    // ended. Guarding the blocked case specifically fixed one instance of the rule
    // violation instead of the rule, and the next settled status would have reopened
    // it.
    render(
      <IngestJobView
        job={job({
          ingest: { status: "failed", attempts: [] },
          compile: { status: "skipped", progress: null },
        })}
      />,
    );

    expect(screen.queryByTestId("progress-indeterminate")).toBeNull();
    expect(screen.queryByTestId("progress-exact")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("says the compile never started, and what to do about it", () => {
    render(
      <IngestJobView
        job={job({
          ingest: { status: "failed", attempts: [] },
          compile: { status: "skipped", progress: null },
        })}
      />,
    );

    const hint = screen.getByTestId("compile-blocked");
    // Waiting is the wrong action here, so the copy must say what the right one is.
    expect(hint.textContent).toMatch(/Saving the source again|never started/i);
  });

  it("shows NO indicator for a compile skipped on request", () => {
    // THIS is the test that actually pins the rule, and I only found that by mutation
    // checking: the blocked case above never reaches ProgressIndicator at all, because
    // the view renders its hint instead. So deleting the settled guard left that test
    // green — a vacuous fixture, exactly the vice this project already has a lesson
    // about. This case DOES reach the indicator, with `progress: null`, after a
    // successful ingest where the caller declined to compile.
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: {
            status: "skipped",
            progress: null,
            message: "Compile skipped on request.",
          },
        })}
      />,
    );

    expect(screen.queryByTestId("progress-indeterminate")).toBeNull();
    expect(screen.queryByTestId("progress-exact")).toBeNull();
  });

  it("does not paint a never-started compile as success", () => {
    // `skipped` is green in the tone map, and usually it deserves to be. But a compile
    // that never ran because the ingest failed is not a success, and the status word
    // alone cannot tell the two apart — only the ingestion outcome can. A green badge
    // directly above "the compile never started" is the same defect as the spinner, in
    // the colour channel.
    const { container } = render(
      <IngestJobView
        job={job({
          ingest: { status: "failed", attempts: [] },
          compile: { status: "skipped", progress: null },
        })}
      />,
    );

    const compileBadge = container.querySelector(
      '[data-testid="dimension-compile"] .badge',
    ) as HTMLElement | null;
    expect(compileBadge).not.toBeNull();
    expect(compileBadge?.className).not.toMatch(/badge--good/);
  });

  it("still paints a skipped-on-request compile as success", () => {
    // The complement: declining to compile is a normal, complete outcome, so the tone
    // must stay green. Only the failed-ingest case is recoloured.
    const { container } = render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "skipped", progress: null },
        })}
      />,
    );

    const compileBadge = container.querySelector(
      '[data-testid="dimension-compile"] .badge',
    ) as HTMLElement | null;
    expect(compileBadge?.className).toMatch(/badge--good/);
  });

  it("shows a single-source pair as a count, not a bar that reaches 100%", () => {
    // The producer reports a true 0/1 -> 1/1 for a one-document compile. Both numbers
    // are honest, so they stay. But a bar at 100% while the stage is STILL RUNNING
    // says "finished" at the moment the user is waiting - worse than no bar. So the
    // pair is rendered as words and the bar is withheld.
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "running", stage: "extraction", progress: { completed: 1, total: 1 } },
        })}
      />,
    );

    expect(screen.queryByRole("progressbar")).toBeNull();
    const counted = screen.getByTestId("progress-counted");
    expect(counted.textContent).toContain("1 of 1");
  });

  it("does not show a stage name on a succeeded compile", () => {
    // Reported by the user with a real payload: status succeeded, stage embeddings.
    // `stage` is where the run ENDED, not where it is, so rendering it unqualified on
    // a finished job reads as "still embedding" and the user rightly called it a UI
    // bug. A finished job reaches `final`; a failed one keeps its stage, because
    // knowing it died in embeddings rather than extraction is the useful part.
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: {
            status: "succeeded",
            stage: "embeddings",
            progress: null,
            detail: { chunks: 2, requests: 2 },
          },
        })}
      />,
    );

    const compile = screen.getByTestId("dimension-compile");
    expect(compile.textContent).toContain("final");
    expect(compile.textContent).not.toMatch(/embeddings/i);
  });

  it("keeps the stage on a failed compile, because where it died matters", () => {
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "failed", stage: "embeddings", progress: null },
        })}
      />,
    );

    const compile = screen.getByTestId("dimension-compile");
    expect(compile.textContent).toMatch(/embeddings/i);
  });

  it("says a complete-looking count is still working, not frozen", () => {
    // Reported by the user against a live job: stage embeddings, running, 109 of 109,
    // and the panel showed nothing else - which reads as "=", a frozen job. The
    // counters reach the total while the stage is still closing, because a batch lands
    // atomically and the tail work has no counter. Without a word, a complete-looking
    // pair on a RUNNING stage is indistinguishable from a stuck one.
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "running", stage: "embeddings", progress: { completed: 109, total: 109 } },
        })}
      />,
    );

    const counted = screen.getByTestId("progress-counted");
    expect(counted.textContent).toContain("109 of 109");
    expect(counted.textContent).toMatch(/still working/i);
  });

  it("does not claim work continues once a partial count is below the total", () => {
    // The marker must be conditional: 3 of 4 is visibly mid-way, and adding "still
    // working" there would be noise attached to a bar that already shows motion.
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "running", stage: "page_generation", progress: { completed: 3, total: 4 } },
        })}
      />,
    );

    expect(screen.getByRole("progressbar")).toBeDefined();
    expect(screen.getByTestId("dimension-compile").textContent).not.toMatch(/still working/i);
  });

  it("shows a single-batch stage as a count, not a bar at 100%", async () => {
    // The producer documents this: the provider answers a batch atomically, so with
    // the default batch size a whole stage jumps to N/N while still running. It is
    // correct upstream and must not be read as a stall - and equally must not be
    // drawn as completion while the user is still waiting.
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "running", stage: "embeddings", progress: { completed: 2, total: 2 } },
        })}
      />,
    );

    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("progress-counted").textContent).toContain("2 of 2");
  });

  it("shows chunk and request counts as text after the stage settles", () => {
    // The producer's own regression: the merge deleted `detail` whenever a patch did
    // not mention it, so the cardinality vanished on every status transition - the
    // exact moment an operator reads it. This renders the settled shape.
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: {
            status: "succeeded",
            stage: "embeddings",
            progress: null,
            detail: { chunks: 14, requests: 6 },
          },
        })}
      />,
    );

    const line = screen.getByTestId("compile-detail");
    expect(line.textContent).toContain("14 chunks");
    expect(line.textContent).toContain("6 requests");
  });

  it("says nothing when the producer published no detail", () => {
    // Absent means absent. A stage that never published chunks must not render an
    // empty or zeroed line - that is the same lie as a fabricated null.
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "succeeded", stage: "page_generation", progress: { completed: 4, total: 5 } },
        })}
      />,
    );

    expect(screen.queryByTestId("compile-detail")).toBeNull();
  });

  it("states a real zero rather than hiding it", () => {
    // A genuine zero is a measurement. The producer omits zeros, so a zero arriving
    // here was actually counted, and suppressing it would discard a true fact.
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: {
            status: "succeeded",
            stage: "embeddings",
            progress: null,
            detail: { chunks: 0, requests: 0 },
          },
        })}
      />,
    );

    const line = screen.getByTestId("compile-detail");
    expect(line.textContent).toContain("0 chunks");
  });

  it("still draws the bar once the total is worth drawing", () => {
    // The complement: two or more is a ratio a bar can actually communicate.
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "running", stage: "extraction", progress: { completed: 7, total: 18 } },
        })}
      />,
    );

    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("7");
    expect(bar.getAttribute("aria-valuemax")).toBe("18");
  });

  it("shows the exact pair when the stage knows its total", () => {
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: {
            status: "running",
            stage: "page_generation",
            progress: { completed: 3, total: 8 },
          },
        })}
      />,
    );

    expect(screen.getByText("3 of 8")).toBeDefined();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("3");
    expect(bar.getAttribute("aria-valuemax")).toBe("8");
  });

  it("does not render a bogus width for a zero total", () => {
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "running", stage: "finalize", progress: { completed: 0, total: 0 } },
        })}
      />,
    );
    // The pair is shown as it is, and no bar is drawn: a total of 0 has no width to
    // communicate, and the previous behaviour - a 0%-wide bar - was a division guard
    // dressed up as progress. Same rule as total<=1, so both share one branch.
    expect(screen.getByText("0 of 0")).toBeDefined();
    expect(document.querySelector(".progress__fill")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("IngestJobView: attempts", () => {
  it("shows an in-flight attempt and a rolled-back one differently", () => {
    render(
      <IngestJobView
        job={job({
          ingest: {
            status: "running",
            stage: "committing",
            attempts: [
              { attempt: 1, startedAt: "a", endedAt: "b", error: "connection reset" },
              { attempt: 2, startedAt: "c" },
            ],
          },
        })}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("#1");
    expect(items[0]?.textContent).toContain("rolled back");
    expect(items[0]?.textContent).toContain("connection reset");
    expect(items[1]?.textContent).toContain("in flight");
  });

  it("says so when no attempt has started yet", () => {
    render(<IngestJobView job={job()} />);
    expect(screen.getByText("No attempts yet.")).toBeDefined();
  });
});

describe("IngestJobView: the states that get mistaken for failure", () => {
  it("does not call a busy compile a failure, and explains the source is safe", () => {
    render(
      <IngestJobView
        job={job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "busy", progress: null },
        })}
      />,
    );

    const compile = screen.getByTestId("dimension-compile");
    expect(compile.textContent).not.toMatch(/fail/i);
    expect(compile.textContent).toMatch(/Only the compile needs a retry/);
    expect(document.querySelector('[data-status="busy"]')?.getAttribute("data-settled")).toBe("true");
  });

  it("marks unchanged as terminal without ever calling it succeeded", () => {
    render(
      <IngestJobView
        job={job({
          ingest: { status: "unchanged", attempts: [] },
          compile: { status: "skipped", progress: null },
        })}
      />,
    );

    const ingest = screen.getByTestId("dimension-ingest");
    expect(ingest.textContent).toContain("unchanged");
    expect(ingest.textContent).not.toContain("succeeded");
    expect(document.querySelector('[data-status="unchanged"]')?.getAttribute("data-settled")).toBe(
      "true",
    );
  });

  it("shows a real ingest error", () => {
    render(
      <IngestJobView
        job={job({
          ingest: { status: "failed", attempts: [], error: "ingest failed after 2 attempts" },
          compile: { status: "skipped", progress: null },
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("ingest failed after 2 attempts");
  });
});

describe("noticeFor: 503 and 404 are different facts", () => {
  it("turns a 503 into 'not tracked', never into 'expired'", () => {
    const notice = noticeForOutcome({
      reason: "unavailable",
      message: "This host does not track ingest jobs, so the status cannot be read.",
    });
    expect(notice?.kind).toBe("unavailable");
    expect(notice?.message).not.toMatch(/no longer known|expired/i);
  });

  it("turns a 404 into 'expired', naming the retention window", () => {
    const notice = noticeForOutcome({
      reason: "unknown",
      message: "This job is no longer known to the host.",
    });
    expect(notice?.kind).toBe("unknown");
  });

  it("has no notice for a settled or aborted job", () => {
    expect(noticeForOutcome({ reason: "settled" })).toBeNull();
    expect(noticeForOutcome({ reason: "aborted" })).toBeNull();
  });

  it("distinguishes an unconfigured deployment from an untracked host", () => {
    // Both arrive as 503, but one is "you never set LLMWIKI_BASE_URL".
    const notConfigured = noticeFor(new ApiError(503, "ingest_not_configured", "nope"));
    expect(notConfigured?.message).toMatch(/no ingest service configured/);

    const untracked = noticeFor(new ApiError(503, "jobs_unavailable", "nope"));
    expect(untracked?.message).toMatch(/does not track jobs/);
  });
});

describe("noticeFor: a 409 is two different facts", () => {
  it("shows the host's own code and words for the two job-control refusals", () => {
    // The delete/retry vocabulary. `job_still_working` means the job is alive and was
    // NOT interrupted; `job_changed` means it moved under us. Both are answers about a
    // specific job, and both keep the service's own words instead of a paraphrase.
    const stillWorking = noticeFor(
      new ApiError(409, "job_still_working", "job job_1 is still working; it was not deleted."),
    );
    expect(stillWorking).toEqual({
      kind: "error",
      message: "job_still_working: job job_1 is still working; it was not deleted.",
    });

    const changed = noticeFor(
      new ApiError(409, "job_changed", "job job_1 changed while you were acting on it."),
    );
    expect(changed).toEqual({
      kind: "error",
      message: "job_changed: job job_1 changed while you were acting on it.",
    });
  });

  it("keeps the retry-signal sentence for the lock, which is no job-control answer", () => {
    // The concurrency lock is the same status and a different fact. Its sentence predates
    // the operator controls and is quoted literally, because it is what the user reads.
    const sentence = "Another ingest is running. That is a retry signal, not a failure.";
    expect(noticeFor(new ApiError(409, "busy", "another mutation holds the lock"))).toEqual({
      kind: "error",
      message: sentence,
    });
    expect(noticeFor(new ApiError(409, undefined, "request failed with 409"))).toEqual({
      kind: "error",
      message: sentence,
    });
  });
});

/**
 * A THIRD FACT ON THE SAME STATUS CODE
 *
 * Since the delete guard landed, a `409` also answers "this document's content is still
 * compiled by the wiki". Mapping that one to the concurrency sentence would tell the
 * operator to retry something that will keep being refused, and would throw away the
 * only part of the answer that says what WOULD work: the retraction endpoint.
 */
describe("noticeFor: a 409 about a document is its own fact", () => {
  /** The exact body the delete guard answers, as the contract states it. */
  const SERVER_SAID =
    'Document "d1" is ingested; retract it with POST /documents/d1/retract before deleting it';

  it("shows the server's sentence verbatim, retraction and all", () => {
    const notice = noticeFor(new ApiError(409, "document_ingested", SERVER_SAID));

    expect(notice).toEqual({ kind: "error", message: SERVER_SAID });
    // Verbatim means verbatim: no code prefix invented here, and the endpoint that
    // would fix it survives to the screen.
    expect(notice?.message.startsWith("document_ingested")).toBe(false);
    expect(notice?.message).toContain("retract");
  });

  it("never answers a document refusal with the concurrency sentence", () => {
    // A body naming the code and nothing usable must still not borrow the lock's
    // "retry signal": nothing about an ingested document is a retry.
    for (const said of ["request failed with 409", ""]) {
      const notice = noticeFor(new ApiError(409, "document_ingested", said));
      expect(notice?.message).not.toContain("Another ingest is running");
      expect(notice?.message).toMatch(/retract/i);
    }
  });
});

/**
 * THE SAME STATUS CODE, THE OPPOSITE DOCUMENT FACT
 *
 * `409 document_not_ingested` is what `POST /documents/:id/retract` answers when there was
 * nothing to retract: no `document_ingests` row for that document in that Stack. S5 added
 * it to `DOCUMENT_REFUSAL_CODES`, and until this block existed the ONLY versioned evidence
 * of that string was the delete guard's neighbouring case — so a later edit could have
 * dropped it back into the concurrency sentence with every test still green.
 *
 * No client call produces the code yet (S7 wires the button), so these pin the MAPPING:
 * the notice is what every documents call would show for that answer, and it has to be the
 * service's own sentence. The first two cases are the pure mapping, in the same style as
 * the block above; the third drives it over the REAL hook and client, which is the only
 * place a request exists to inspect for a synthetic identity header.
 */
describe("noticeFor: 409 document_not_ingested is a document fact too", () => {
  /** The exact shape the retract endpoint answers with, quoted rather than summarised. */
  const RETRACT_SAID =
    'Document "d1" has no ingest in Stack "A"; there is nothing to retract.';

  it("shows the server's sentence verbatim and whole", () => {
    const notice = noticeFor(new ApiError(409, "document_not_ingested", RETRACT_SAID));

    // Literal equality on the WHOLE sentence: no prefix invented, nothing trimmed, and a
    // `toContain` would have passed on a message that had grown either.
    expect(notice).toEqual({ kind: "error", message: RETRACT_SAID });
    expect(notice?.message.startsWith("document_not_ingested")).toBe(false);
    // And the lock's retry signal is the wrong advice for "there was nothing to retract".
    expect(notice?.message).not.toContain("Another ingest is running");
  });

  it("falls back to our own sentence, pinned exactly, when the body names nothing", () => {
    // PINNED, not matched loosely. The fallback is THIS code's own fact: there is no
    // ingest in that Stack, so there is nothing to retract. It is deliberately not the
    // delete guard's sentence ("This document is ingested; retract it…"), which states
    // the opposite, and asserting the whole string character for character is what keeps
    // the two from being collapsed back into one another. Both shapes the mapper treats
    // as "heard nothing" are covered: an empty body, and the client's own `request
    // failed with 409`.
    const FALLBACK =
      "There is no ingest of this document in this Stack, so there is nothing to retract.";
    expect(noticeFor(new ApiError(409, "document_not_ingested", ""))).toEqual({
      kind: "error",
      message: FALLBACK,
    });
    expect(
      noticeFor(new ApiError(409, "document_not_ingested", "request failed with 409")),
    ).toEqual({ kind: "error", message: FALLBACK });
    // Whatever the fallback becomes, it is never the concurrency lock.
    expect(FALLBACK).not.toContain("Another ingest is running");
  });
});

/** A hand-built result object, so the panel is testable without a live client. */
function fakeIngest(overrides: Partial<UseIngestResult> = {}): UseIngestResult {
  return {
    stackId: "0f8b1e42-1111-2222-3333-444455556666",
    resolvedStackId: "0f8b1e42-1111-2222-3333-444455556666",
    stackIds: ["0f8b1e42-1111-2222-3333-444455556666"],
    chooseStackId: vi.fn(),
    blockedProblem: null,
    documents: [],
    uploading: false,
    listDocuments: vi.fn(async () => {}),
    upload: vi.fn(async () => null),
    removeDocument: vi.fn(async () => {}),
    retractDocument: vi.fn(async () => {}),
    ingestDocument: vi.fn(async () => {}),
    documentsNotice: null,
    jobs: [],
    activeJob: null,
    activeId: null,
    loadingList: false,
    listNotice: null,
    pollNotice: null,
    starting: false,
    following: false,
    setListLive: vi.fn(),
    start: vi.fn(async () => {}),
    follow: vi.fn(),
    stopFollowing: vi.fn(),
    refreshList: vi.fn(async () => {}),
    deleteJob: vi.fn(async () => {}),
    retryJob: vi.fn(async () => {}),
    deletingIds: new Set<string>(),
    retryingIds: new Set<string>(),
    retractingIds: new Set<string>(),
    clearPollNotice: vi.fn(),
    ...overrides,
  };
}

describe("IngestJobsPanel", () => {
  it("says where a path is resolved, and that an extension decides parsing", () => {
    render(<IngestJobsPanel ingest={fakeIngest()} onClose={() => {}} />);
    // A typed path never means "here": the service resolves it on its own machine.
    expect(screen.getByText(/resolved on the machine that runs it/)).toBeDefined();
    // And an upload's name is load-bearing, not cosmetic.
    expect(screen.getByText(/extension decides how it is parsed/)).toBeDefined();
  });

  it("uploads a chosen file and does NOT start an ingest by itself", async () => {
    const upload = vi.fn(async () => null);
    const ingestDocument = vi.fn(async () => {});
    render(<IngestJobsPanel ingest={fakeIngest({ upload, ingestDocument })} onClose={() => {}} />);

    const input = screen.getByLabelText("Choose a document") as HTMLInputElement;
    const file = new File(["%PDF-1.4"], "contrato.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(upload).toHaveBeenCalledWith(file);
    // Upload is storage; ingest is a separate, deliberate action.
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("lists uploaded documents and ingests one by reference", () => {
    const ingestDocument = vi.fn(async () => {});
    render(
      <IngestJobsPanel
        ingest={fakeIngest({
          documents: [
            {
              id: "d1",
              filename: "contrato.pdf",
              bytes: 2048,
              contentType: "application/pdf",
              createdAt: "",
              contentHash: null,
              ingest: null,
            },
          ],
          ingestDocument,
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("contrato.pdf")).toBeDefined();
    expect(screen.getByText("2 KB")).toBeDefined();
    fireEvent.click(screen.getByText("Ingest"));
    // Document ingestion has its own entry point here, so it uses the same chosen
    // Stack as the source form instead of falling back to a second rule.
    expect(ingestDocument).toHaveBeenCalledWith("d1", {
      compile: true,
      stackId: "0f8b1e42-1111-2222-3333-444455556666",
    });
  });

  it("keeps the read surface off, and offers the Stack choice, when the link names no stack", () => {
    // The link is the source of the tenant's READS, so a link without one has nothing
    // to list: no upload box, no document list, no job list. What stays is the choice
    // S3 asks for (a Stack picked here scopes the ingest started here) and a way back.
    const onClose = vi.fn();
    render(
      <IngestJobsPanel
        ingest={fakeIngest({
          stackId: null,
          resolvedStackId: null,
          stackIds: [],
          blockedProblem: MISSING_STACK_ID_PROBLEM,
        })}
        onClose={onClose}
      />,
    );

    // The read block names the parameter AND the shape the link must have: a user can
    // only fix what is named. It is the one ANNOUNCED notice; the write block is the
    // exact S4 copy, stated as the state of the control rather than announced twice.
    const alerts = screen.getAllByRole("alert").map((node) => node.textContent);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("?stackId=<stack-id>");
    // And it no longer sends anyone to a link that names a user (S3).
    expect(alerts[0]).not.toContain("?user=");
    expect(screen.getByText(UNRESOLVED_STACK_ID_NOTICE)).toBeDefined();

    // No Stack resolved means no form: there is nothing to submit into, so the panel
    // offers nothing that would send a request nobody named.
    expect(screen.getByLabelText("Stack")).toBeDefined();
    expect(screen.queryByLabelText("Choose a document")).toBeNull();
    expect(screen.queryByLabelText("Source")).toBeNull();
    expect(screen.queryByText("Start ingest")).toBeNull();
    expect(screen.queryByText("No documents uploaded yet.")).toBeNull();
    expect(screen.queryByText("Recent")).toBeNull();

    // Blocked is not a dead end: the chat still works without a tenant.
    fireEvent.click(screen.getByText("Back to chat"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the whole panel, with the link's Stack preselected", () => {
    render(<IngestJobsPanel ingest={fakeIngest()} onClose={() => {}} />);

    expect(screen.queryByRole("alert")).toBeNull();
    const select = screen.getByLabelText("Stack") as HTMLSelectElement;
    expect(select.value).toBe("0f8b1e42-1111-2222-3333-444455556666");
    expect(screen.getByLabelText("Source")).toBeDefined();
    expect(screen.getByText("Start ingest")).toBeDefined();
    expect(screen.getByText("No documents uploaded yet.")).toBeDefined();
  });

  it("says so when nothing has been uploaded", () => {
    render(<IngestJobsPanel ingest={fakeIngest()} onClose={() => {}} />);
    expect(screen.getByText("No documents uploaded yet.")).toBeDefined();
  });

  it("starts a job with the compile choice it was given", () => {
    const start = vi.fn(async () => {});
    render(<IngestJobsPanel ingest={fakeIngest({ start })} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "https://example.com/x" },
    });
    fireEvent.click(screen.getByLabelText(/Compile after ingesting/)); // turn it off
    fireEvent.click(screen.getByText("Start ingest"));

    expect(start).toHaveBeenCalledWith("https://example.com/x", {
      compile: false,
      stackId: "0f8b1e42-1111-2222-3333-444455556666",
    });
  });

  it("will not start a blank source", () => {
    const start = vi.fn(async () => {});
    render(<IngestJobsPanel ingest={fakeIngest({ start })} onClose={() => {}} />);
    const button = screen.getByText("Start ingest") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("lists jobs with a summary that names which half is moving", () => {
    render(
      <IngestJobsPanel
        ingest={fakeIngest({
          jobs: [
            job({
              ingest: { status: "succeeded", attempts: [] },
              compile: { status: "running", stage: "finalize", progress: null },
            }),
          ],
        })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Source saved · compiling · finalizing/)).toBeDefined();
  });

  it("marks a job that is still moving as live, and a settled one as not", () => {
    render(
      <IngestJobsPanel
        ingest={fakeIngest({
          jobs: [
            job({ id: "ing_live" }),
            job({
              id: "ing_done",
              ingest: { status: "succeeded", attempts: [] },
              compile: { status: "succeeded", progress: null },
            }),
          ],
        })}
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByText("live")).toHaveLength(1);
  });

  it("follows a job when its row is clicked", () => {
    const follow = vi.fn();
    render(
      <IngestJobsPanel ingest={fakeIngest({ jobs: [job()], follow })} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByText(/Ingesting ·/));
    expect(follow).toHaveBeenCalledWith("ing_01J8Z4Q7X3");
  });

  it("shows the poll notice verbatim and lets it be dismissed", () => {
    const clearPollNotice = vi.fn();
    render(
      <IngestJobsPanel
        ingest={fakeIngest({
          pollNotice: { kind: "unavailable", message: "This host does not track ingest jobs." },
          clearPollNotice,
        })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("does not track ingest jobs");
    fireEvent.click(screen.getByText("Dismiss"));
    expect(clearPollNotice).toHaveBeenCalled();
  });
});

/**
 * The hook, driven through the real ApiClient with a stubbed fetch.
 *
 * This is the integration the component tests cannot see: a 503 from the server
 * must arrive as an `unavailable` notice and NOT as a job that vanished.
 */
describe("useIngest wiring", () => {
  function Probe({
    client,
    stackId,
    onRender,
  }: {
    client: ApiClient;
    stackId: string | null;
    onRender: (r: UseIngestResult) => void;
  }) {
    const result = useIngest({ client, stackId });
    onRender(result);
    return (
      <div>
        <span data-testid="notice">{result.pollNotice?.kind ?? "none"}</span>
        <span data-testid="following">{String(result.following)}</span>
      </div>
    );
  }

  it("reports a 503 as unavailable rather than unknown", async () => {
    const client = new ApiClient({
      baseUrl: "/api",
      headers: () => ({ "x-dev-token": "t" }),
      fetchImpl: (async (url: string) => {
        if (String(url).endsWith("/ingest/jobs")) {
          return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: { code: "jobs_unavailable" } }), { status: 503 });
      }) as unknown as typeof fetch,
    });

    let latest: UseIngestResult | undefined;
    render(<Probe client={client} stackId="0f8b1e42" onRender={(r) => (latest = r)} />);

    await waitFor(() => expect(latest?.loadingList).toBe(false));
    latest!.follow("ing_1");

    await waitFor(() => expect(screen.getByTestId("notice").textContent).toBe("unavailable"));
    expect(screen.getByTestId("following").textContent).toBe("false");
  });

  it("issues no request at all when the link names no stack", async () => {
    // This is the whole reason the block exists. A list read with no Stack is not an
    // empty list: it is somebody else's data or an error the user cannot read, so
    // the correct number of requests here is zero.
    const seen: string[] = [];
    const client = new ApiClient({
      baseUrl: "/api",
      headers: () => ({ "x-user-id": "alice" }),
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ jobs: [], documents: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    let latest: UseIngestResult | undefined;
    render(<Probe client={client} stackId={null} onRender={(r) => (latest = r)} />);

    await waitFor(() => expect(latest).toBeDefined());
    // The ONE request this state may make is `GET /stacks`, and it is not a read of a
    // tenant: it is the list of choices the S4 copy tells the user to pick from, so it
    // cannot itself require already knowing a Stack. Everything tenant-scoped stays at
    // zero — a jobs or documents read with no Stack is somebody else's data.
    const tenantRequests = () => seen.filter((url) => !url.endsWith("/stacks"));
    expect(tenantRequests()).toEqual([]);
    expect(latest!.loadingList).toBe(false);
    expect(latest!.stackId).toBeNull();
    expect(latest!.blockedProblem).toContain("stackId");

    // Every action the panel could still reach, including the ones it no longer
    // renders, stops at the hook instead of reaching the client.
    latest!.follow("ing_1");
    latest!.stopFollowing();
    await latest!.start("https://example.com/a");
    await latest!.ingestDocument("d1");
    await latest!.refreshList();
    await latest!.listDocuments();
    expect(tenantRequests()).toEqual([]);
  });

  it("reports a 404 as unknown", async () => {
    const client = new ApiClient({
      baseUrl: "/api",
      headers: () => ({ "x-dev-token": "t" }),
      fetchImpl: (async (url: string) => {
        if (String(url).endsWith("/ingest/jobs")) {
          return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: { code: "job_not_found" } }), { status: 404 });
      }) as unknown as typeof fetch,
    });

    let latest: UseIngestResult | undefined;
    render(<Probe client={client} stackId="0f8b1e42" onRender={(r) => (latest = r)} />);

    await waitFor(() => expect(latest?.loadingList).toBe(false));
    latest!.follow("ing_1");

    // A single 404 is TOLERATED now: a foreign Stack's durable mirror can lag by a
    // tick, and reporting the first one as expired would call a running job gone.
    // The notice only appears once the 404 persists, so this asserts the eventual
    // outcome rather than the first read.
    await waitFor(
      () => expect(screen.getByTestId("notice").textContent).toBe("unknown"),
      { timeout: 5_000 },
    );
  });
});

/**
 * The Stack the ingest uses, driven end to end: the panel over the REAL hook and the
 * REAL client, with only the transport stubbed.
 *
 * Nothing here asserts hook or component internals, because the two facts S3/S4 are
 * about are both public: which Stack the control shows as selected (the rendered
 * select) and which Stack the request carries (what the client serialized). A mocked
 * `start()` would prove neither, and it is exactly the seam where the old bug — the
 * link's value overwriting the choice — used to be invisible.
 */

const SETTLED_JOB: IngestJob = {
  id: "job_1",
  source: "https://example.com/a",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ingest: { status: "succeeded", stage: "committing", attempts: [] },
  compile: { status: "succeeded", stage: "finalize", progress: null },
};

interface Wire {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
  /** The headers the client actually sent, so a legacy identity header can be refused. */
  headers: Record<string, string>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * One row of `GET /documents` as the server now answers it.
 *
 * `current` is deliberately built by the CALLER: when the wiki cannot be read the
 * server omits the key entirely, and a helper that defaulted it would make that third
 * state unrepresentable in a test.
 */
function ingestState(overrides: Partial<DocumentIngestState> = {}): DocumentIngestState {
  return {
    jobId: "job_1",
    requestedAt: "2026-01-01T00:00:00.000Z",
    ingestedAt: "2026-01-01T00:00:10.000Z",
    known: true,
    ...overrides,
  };
}

/** A stored document plus the ingest state the listing carries for it. */
function listedDocument(overrides: Partial<ListedDocument> = {}): ListedDocument {
  return {
    id: "d1",
    filename: "contrato.pdf",
    bytes: 2048,
    contentType: "application/pdf",
    createdAt: "2026-01-01T00:00:00.000Z",
    contentHash: "a3".repeat(32),
    ingest: ingestState({ current: true }),
    ...overrides,
  };
}

/**
 * A real client over a recording transport. `answer` gets first refusal on each
 * request, which is how one test makes `GET /stacks` list two Stacks and another
 * makes it fail; everything else answers the settled-job shape so the poll loop
 * ends on its first read instead of scheduling timers.
 */
function stackingClient(
  answer: (wire: Wire) => Response | undefined,
  /**
   * The headers the client sends. The default is the legacy shape a few older cases
   * still build; `{}` is what the app itself sends (cookie only), which is what the
   * document cases use so they can prove no identity header goes out.
   */
  identityHeaders: Record<string, string> = { "x-user-id": "alice" },
) {
  const seen: Wire[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    const wire: Wire = {
      method,
      url: href,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    };
    seen.push(wire);

    const custom = answer(wire);
    if (custom) return custom;

    if (method === "POST" && href.endsWith("/ingest/jobs")) {
      return jsonResponse(
        {
          jobId: SETTLED_JOB.id,
          status: "queued",
          stage: "queued",
          ingest: { status: "queued", attempts: [] },
          compile: { status: "queued", progress: null },
        },
        202,
      );
    }
    if (href.includes("/ingest/jobs/")) return jsonResponse(SETTLED_JOB);
    if (href.endsWith("/documents")) return jsonResponse({ documents: [] });
    return jsonResponse({ jobs: [] });
  }) as unknown as typeof fetch;

  const client = new ApiClient({
    baseUrl: "/api",
    headers: () => identityHeaders,
    fetchImpl,
  });

  return {
    client,
    seen,
    posts: () => seen.filter((wire) => wire.method === "POST"),
    polls: () => seen.filter((wire) => wire.method === "GET" && wire.url.includes("/ingest/jobs/")),
  };
}

function StackPanel({ client, stackId }: { client: ApiClient; stackId: string | null }) {
  const ingest = useIngest({ client, stackId });
  return <IngestJobsPanel ingest={ingest} onClose={() => {}} />;
}

describe("IngestJobsPanel: the Stack the ingest uses", () => {
  it("offers the known Stacks, preselects the link's, and submits the chosen one (S3)", async () => {
    const { client, posts } = stackingClient(({ method, url }) =>
      method === "GET" && url.endsWith("/stacks")
        ? jsonResponse({ stackIds: ["A", "C"] })
        : undefined,
    );

    render(<StackPanel client={client} stackId="A" />);

    // Preselected from the link, before the list even answers: the panel is usable
    // with what the link already says.
    const select = screen.getByLabelText("Stack") as HTMLSelectElement;
    expect(select.value).toBe("A");

    await waitFor(() => expect(screen.getByRole("option", { name: "C" })).toBeDefined());

    fireEvent.change(select, { target: { value: "C" } });
    expect(select.value).toBe("C");

    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "https://example.com/a" },
    });
    fireEvent.click(screen.getByText("Start ingest"));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({
      source: "https://example.com/a",
      compile: true,
      stackId: "C",
    });
  });

  it("watches the job it started in the chosen Stack when the link names none (S3)", async () => {
    // The known gap this pins: with no Stack in the link, the POST went out but the
    // poll was still gated on the link, so the job never showed progress. A POST
    // alone is not the behavior; the follow has to read the same tenant.
    const { client, posts, polls } = stackingClient(({ method, url }) =>
      method === "GET" && url.endsWith("/stacks")
        ? jsonResponse({ stackIds: ["C"] })
        : undefined,
    );

    render(<StackPanel client={client} stackId={null} />);

    const select = screen.getByLabelText("Stack") as HTMLSelectElement;
    expect(select.value).toBe("");
    await waitFor(() => expect(screen.getByRole("option", { name: "C" })).toBeDefined());
    fireEvent.change(select, { target: { value: "C" } });

    // Choosing a Stack is what makes the write surface available: the panel stays
    // visible and explains itself, it does not stay inert.
    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "https://example.com/a" },
    });
    fireEvent.click(screen.getByText("Start ingest"));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({
      source: "https://example.com/a",
      compile: true,
      stackId: "C",
    });

    await waitFor(() => expect(polls().length).toBeGreaterThan(0));
    expect(polls()[0]!.url).toContain("stackId=C");
  });

  it("still submits the link's Stack when the control is never touched (S2)", async () => {
    const { client, posts } = stackingClient(({ method, url }) =>
      method === "GET" && url.endsWith("/stacks")
        ? jsonResponse({ stackIds: ["A", "C"] })
        : undefined,
    );

    render(<StackPanel client={client} stackId="A" />);
    await waitFor(() => expect(screen.getByRole("option", { name: "C" })).toBeDefined());

    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "https://example.com/a" },
    });
    fireEvent.click(screen.getByText("Start ingest"));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({
      source: "https://example.com/a",
      compile: true,
      stackId: "A",
    });
  });

  it("states that no Stack is named, and starts nothing, when no Stack can be resolved (S4)", async () => {
    const { client, posts } = stackingClient(({ method, url }) =>
      method === "GET" && url.endsWith("/stacks")
        ? jsonResponse({ stackIds: [] })
        : undefined,
    );

    render(<StackPanel client={client} stackId={null} />);

    await waitFor(() => expect(screen.getByLabelText("Stack")).toBeDefined());

    // The exact copy, not a second sentence invented here: no Stack chosen and none
    // in the link is the S4 case, and the panel says it rather than pretending.
    expect(screen.getByText(UNRESOLVED_STACK_ID_NOTICE)).toBeDefined();

    // Nothing to submit into, so nothing was submitted: the surface is not a dead
    // end, it is honest about the missing tenant.
    expect(screen.queryByText("Start ingest")).toBeNull();
    expect(posts()).toEqual([]);
  });

  it("keeps the panel usable, with the link's Stack selectable, when GET /stacks fails (S3)", async () => {
    const { client } = stackingClient(({ method, url }) =>
      method === "GET" && url.endsWith("/stacks")
        ? jsonResponse({ error: { code: "internal_error" } }, 500)
        : undefined,
    );

    render(<StackPanel client={client} stackId="A" />);

    // A list of choices that could not be read is not an ingest that cannot run: the
    // link's Stack still names the right tenant, so it must remain the selected and
    // available value instead of the control going blank.
    const select = screen.getByLabelText("Stack") as HTMLSelectElement;
    expect(select.value).toBe("A");
    expect(screen.getByRole("option", { name: "A" })).toBeDefined();
    expect(screen.getByLabelText("Source")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/**
 * WHY THESE ASSERTIONS
 *
 * The operator controls are the surface's most dangerous buttons, and the rules they
 * must not break are all invisible from a screenshot:
 *
 *   - they belong to the job the user is LOOKING AT, and act on that id;
 *   - they are disabled while THAT id's request is out, so a double click cannot mean
 *     two deletes;
 *   - they are not pre-judged: a running job still offers Delete, because the `409` is
 *     the authority on whether it may be deleted, not our reading of its status;
 *   - a refusal is rendered in the host's own words (`job_still_working`), because a
 *     working job is REFUSED, not stopped — there is no cancel anywhere in this product;
 *   - deleting the job being watched leaves no spinner and no stale detail behind.
 */
describe("IngestJobsPanel: delete and retry", () => {
  it("offers Delete and Retry for the job on screen, and acts on its id", () => {
    const deleteJob = vi.fn(async () => {});
    const retryJob = vi.fn(async () => {});
    const active = job();
    render(
      <IngestJobsPanel
        ingest={fakeIngest({ activeJob: active, activeId: active.id, deleteJob, retryJob })}
        onClose={() => {}}
      />,
    );

    const del = screen.getByRole("button", { name: new RegExp(`Delete job ${active.id}`) });
    const retry = screen.getByRole("button", { name: new RegExp(`Retry job ${active.id}`) });

    fireEvent.click(del);
    fireEvent.click(retry);
    expect(deleteJob).toHaveBeenCalledWith(active.id);
    expect(retryJob).toHaveBeenCalledWith(active.id);
  });

  it("does not pre-judge deletability from the job's status", () => {
    // The row is still moving, which is exactly the case the host answers with
    // `409 job_still_working`. Disabling the button here would be our guess winning over
    // the service's answer — and it would hide the refusal the user needs to read.
    const active = job({ ingest: { status: "running", stage: "committing", attempts: [] } });
    render(
      <IngestJobsPanel
        ingest={fakeIngest({ activeJob: active, activeId: active.id })}
        onClose={() => {}}
      />,
    );

    const del = screen.getByRole("button", { name: new RegExp(`Delete job ${active.id}`) }) as HTMLButtonElement;
    const retry = screen.getByRole("button", { name: new RegExp(`Retry job ${active.id}`) }) as HTMLButtonElement;
    expect(del.disabled).toBe(false);
    expect(retry.disabled).toBe(false);
  });

  it("disables them while that job's own request is in flight", () => {
    const active = job();
    const { rerender } = render(
      <IngestJobsPanel
        ingest={fakeIngest({ activeJob: active, activeId: active.id, deletingIds: new Set([active.id]) })}
        onClose={() => {}}
      />,
    );

    // While the delete is out, one click cannot become two, and the label says which
    // request is running rather than leaving a dead-looking button.
    const deleting = screen.getByRole("button", { name: new RegExp(`Delete job ${active.id}`) }) as HTMLButtonElement;
    const retryWhileDeleting = screen.getByRole("button", { name: new RegExp(`Retry job ${active.id}`) }) as HTMLButtonElement;
    expect(deleting.disabled).toBe(true);
    expect(deleting.textContent).toBe("Deleting…");
    expect(retryWhileDeleting.disabled).toBe(true);

    rerender(
      <IngestJobsPanel
        ingest={fakeIngest({ activeJob: active, activeId: active.id, retryingIds: new Set([active.id]) })}
        onClose={() => {}}
      />,
    );
    const retrying = screen.getByRole("button", { name: new RegExp(`Retry job ${active.id}`) }) as HTMLButtonElement;
    const delWhileRetrying = screen.getByRole("button", { name: new RegExp(`Delete job ${active.id}`) }) as HTMLButtonElement;
    expect(retrying.disabled).toBe(true);
    expect(retrying.textContent).toBe("Retrying…");
    expect(delWhileRetrying.disabled).toBe(true);
  });

  it("renders no controls at all when the surface is blocked for lack of a Stack", () => {
    // The jobs are supplied on purpose: the controls must be absent because the surface
    // has no tenant, not because the fixture happened to be empty.
    render(
      <IngestJobsPanel
        ingest={fakeIngest({
          stackId: null,
          resolvedStackId: null,
          stackIds: [],
          blockedProblem: MISSING_STACK_ID_PROBLEM,
          jobs: [job()],
          activeJob: job(),
          activeId: job().id,
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /Delete job/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry job/ })).toBeNull();
  });

  it("never offers a cancel, because the upstream service has none", () => {
    const active = job();
    render(
      <IngestJobsPanel
        ingest={fakeIngest({ activeJob: active, activeId: active.id, following: true })}
        onClose={() => {}}
      />,
    );

    // A working job is REFUSED, not stopped. Any control or copy promising interruption
    // would be a promise this product cannot keep.
    for (const name of [/cancel/i, /stop/i, /abort/i, /interrupt/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});

/**
 * THE MARK HAS THREE STATES, AND "UNKNOWN" IS NOT "NO"
 *
 * `GET /documents` says three different things about a document and the panel must not
 * collapse them:
 *
 *   - `current: true`  — the content the wiki holds in this Stack is these bytes;
 *   - `current: false` — it is not, and that is a verified answer, so the row is bare;
 *   - `known: false`   — the wiki could not be read, and the `current` KEY IS ABSENT.
 *     Rendering that as "not ingested" would be a claim about the user's data that
 *     nothing verified, so it says "no data" and says why.
 *
 * The last case here is the cross-cutting one: the mark is derived from the listing the
 * panel already reads, so it costs no request, and no request carries a legacy identity
 * header (`x-user-id` / `x-dev-token` are dead; the tenant travels as `x-stack-id`).
 */
describe("IngestJobsPanel: the ingested mark and the two states that are not it", () => {
  it("marks a document whose content is still the one the wiki holds (S4)", () => {
    const { container } = render(
      <IngestJobsPanel ingest={fakeIngest({ documents: [listedDocument()] })} onClose={() => {}} />,
    );

    const mark = container.querySelector('[data-ingest-state="current"]');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("\u2713");
    // The tooltip says WHAT was verified, because "current" alone is a claim the user
    // cannot check from here.
    expect(mark?.getAttribute("title")).toMatch(/the wiki holds these exact bytes in this Stack/i);
    // And the row's removal control is the retraction-backed one, named for what it does:
    // the "cannot ask for a retraction yet" hint is gone because it is no longer true.
    const row = mark?.closest("li");
    expect(row?.textContent).toContain("Remove from wiki");
    expect(row?.textContent).not.toMatch(/cannot ask for yet/i);
  });

  it("renders NO mark for a document the wiki does not hold", () => {
    const { container } = render(
      <IngestJobsPanel
        ingest={fakeIngest({
          documents: [listedDocument({ ingest: ingestState({ current: false, ingestedAt: null }) })],
        })}
        onClose={() => {}}
      />,
    );

    // A verified "no" is not a marker: the row simply carries nothing.
    expect(container.querySelector("[data-ingest-state]")).toBeNull();
    expect(screen.queryByText("\u2713")).toBeNull();
    // And it is not the unknown state either — those two are different answers.
    expect(container.querySelector('[data-ingest-state="unknown"]')).toBeNull();
    expect(screen.queryByText("no data")).toBeNull();
  });

  it("says 'no data' when the wiki could not be read, never 'not ingested'", () => {
    // `known: false` arrives with NO `current` key on the wire: the absence of the key
    // IS the third state, and the type keeps it expressible instead of coercing it to
    // `false`.
    const { container } = render(
      <IngestJobsPanel
        ingest={fakeIngest({
          documents: [listedDocument({ ingest: ingestState({ known: false, ingestedAt: null }) })],
        })}
        onClose={() => {}}
      />,
    );

    const mark = container.querySelector('[data-ingest-state="unknown"]');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("no data");
    // Visually distinct AND explained: the tooltip names the cause, the wiki read.
    expect(mark?.getAttribute("title")).toMatch(/could not be read/i);
    // Not a check, and distinguishable from the bare "not ingested" row asserted above:
    // one states missing data, the other states nothing at all.
    expect(screen.queryByText("\u2713")).toBeNull();
    expect(screen.queryByText("not ingested")).toBeNull();
  });

  it("renders no mark and no error for a legacy row with no content hash", () => {
    // A row stored before the hash existed has no content identity, so nothing can be
    // said about it: no check, no "no data", and no error box invented from a null.
    const { container } = render(
      <IngestJobsPanel
        ingest={fakeIngest({
          documents: [
            listedDocument({ contentHash: null, ingest: ingestState({ current: false, ingestedAt: null }) }),
            listedDocument({
              id: "d2",
              filename: "sin-hash-y-sin-wiki.pdf",
              contentHash: null,
              ingest: ingestState({ known: false, ingestedAt: null }),
            }),
          ],
        })}
        onClose={() => {}}
      />,
    );

    expect(container.querySelector("[data-ingest-state]")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // Both rows are on screen: this is an absence of a claim, not an absence of data.
    expect(screen.getByText("contrato.pdf")).toBeDefined();
    expect(screen.getByText("sin-hash-y-sin-wiki.pdf")).toBeDefined();
  });

  it("renders all three states from ONE listing and adds no request of its own", async () => {
    const { client, seen } = stackingClient(
      ({ method, url }) =>
        method === "GET" && url.endsWith("/documents")
          ? jsonResponse({
              documents: [
                listedDocument({ id: "d1", filename: "vigente.pdf" }),
                listedDocument({
                  id: "d2",
                  filename: "no-ingestado.pdf",
                  ingest: ingestState({ current: false, ingestedAt: null }),
                }),
                listedDocument({
                  id: "d3",
                  filename: "sin-datos.pdf",
                  ingest: ingestState({ known: false, ingestedAt: null }),
                }),
              ],
            })
          : undefined,
      // The app's own headers: cookie only, no synthetic identity.
      {},
    );

    const { container } = render(<StackPanel client={client} stackId="A" />);
    await screen.findByText("sin-datos.pdf");

    const rowOf = (filename: string) =>
      Array.from(container.querySelectorAll("li")).find((li) => li.textContent?.includes(filename));

    const current = rowOf("vigente.pdf")?.querySelector('[data-ingest-state="current"]');
    expect(current?.textContent).toBe("\u2713");
    const unknown = rowOf("sin-datos.pdf")?.querySelector('[data-ingest-state="unknown"]');
    expect(unknown?.textContent).toBe("no data");
    expect(rowOf("no-ingestado.pdf")?.querySelector("[data-ingest-state]")).toBeNull();

    // The mark costs no request: the panel still reads the listing ONCE.
    expect(seen.filter((wire) => wire.method === "GET" && wire.url.endsWith("/documents"))).toHaveLength(1);
    // And nothing on the wire carries a legacy identity header.
    for (const wire of seen) {
      expect(wire.headers["x-user-id"]).toBeUndefined();
      expect(wire.headers["x-dev-token"]).toBeUndefined();
    }
  });
});

/**
 * REMOVE IS A RETRACTION (S7)
 *
 * `Remove` used to call `DELETE /documents/:id`, which is local cleanup, so an ingested
 * document was refused there and the row said removal was not available yet. The human
 * overrode that gate: removal must consume the retraction endpoint NOW, not after the
 * upstream deletion ships. So the control says what it does, and the wire shows ONE
 * request to the endpoint that does it.
 *
 * What is pinned here, and why each half matters:
 *
 *  - the REQUEST: exactly one `POST /documents/<id>/retract`, carrying the Stack the way
 *    every other document call carries it, and ZERO deletes — a delete riding along is the
 *    regression this step exists to prevent;
 *  - the ANSWER: the `202`'s job id is FOLLOWED (the wiki deletes and recompiles in one
 *    job upstream) and the list is re-read;
 *  - the REFUSALS: the service's own sentence reaches the screen whole, the row stays
 *    listed because nothing was removed, and nothing is retried;
 *  - the CONTROL: disabled while ITS request is out, visible words naming the action, and
 *    the historical accessible name kept byte for byte.
 */
describe("IngestJobsPanel: Remove from wiki consumes the retraction endpoint (S7)", () => {
  const RETRACT_PATH = "/api/documents/d1/retract";

  /** A transport holding one ingested document, answering the retraction as told. */
  function removalClient(answer: (wire: Wire) => Response | undefined) {
    return stackingClient(
      (wire) => {
        if (wire.method === "GET" && wire.url.endsWith("/documents")) {
          return jsonResponse({ documents: [listedDocument()] });
        }
        return answer(wire);
      },
      // The app's own headers: cookie only, no synthetic identity.
      {},
    );
  }

  /**
   * The same transport, with the retraction POST held open.
   *
   * `stackingClient` answers synchronously, and "still in flight" is exactly the state a
   * second click must be refused in — so this one case builds its own transport around a
   * promise the test releases.
   */
  function gatedRemovalClient() {
    const seen: Wire[] = [];
    let open: (response: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => {
      open = resolve;
    });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      seen.push({
        method,
        url: href,
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined,
        headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      });
      if (method === "POST" && href === RETRACT_PATH) return gate;
      if (method === "GET" && href.endsWith("/documents")) {
        return jsonResponse({ documents: [listedDocument()] });
      }
      if (href.includes("/ingest/jobs/")) return jsonResponse(SETTLED_JOB);
      return jsonResponse({ jobs: [] });
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "/api", headers: () => ({}), fetchImpl });
    return { client, seen, release: (response: Response) => open(response) };
  }

  /** The one control this block is about, addressed the way assistive tech names it. */
  const removeButton = () => screen.findByRole("button", { name: "Delete contrato.pdf" });

  const retractions = (seen: Wire[]) =>
    seen.filter((wire) => wire.method === "POST" && wire.url === RETRACT_PATH);

  it("issues ONE retraction POST and no DELETE at all", async () => {
    const { client, seen } = removalClient((wire) =>
      wire.method === "POST" && wire.url === RETRACT_PATH
        ? jsonResponse({ jobId: "job_retract_1" }, 202)
        : undefined,
    );

    render(<StackPanel client={client} stackId="A" />);
    fireEvent.click(await removeButton());

    await waitFor(() => expect(retractions(seen)).toHaveLength(1));
    // The Stack travels the way every other document call carries it (a header), not as a
    // second spelling in the query.
    expect(retractions(seen)[0]!.headers["x-stack-id"]).toBe("A");
    expect(retractions(seen)[0]!.url).not.toContain("?");
    // One click, one request — and NOT the delete, which is a different operation.
    expect(seen.some((wire) => wire.method === "DELETE")).toBe(false);
    expect(seen.some((wire) => wire.url.includes("/documents/d1") && wire.method !== "POST")).toBe(
      false,
    );
  });

  it("follows the job id the acceptance carries, and re-reads the list", async () => {
    const { client, seen } = removalClient((wire) =>
      wire.method === "POST" && wire.url === RETRACT_PATH
        ? jsonResponse({ jobId: "job_retract_7" }, 202)
        : undefined,
    );

    render(<StackPanel client={client} stackId="A" />);
    fireEvent.click(await removeButton());

    // The deletion and the recompile that follows it are ONE job upstream, and this panel
    // is the only surface that can watch it.
    await waitFor(() =>
      expect(
        seen.some((wire) => wire.method === "GET" && wire.url.includes("/ingest/jobs/job_retract_7")),
      ).toBe(true),
    );
    // Accepted means the row's state just changed: one read on mount, one after the accept.
    await waitFor(() =>
      expect(seen.filter((wire) => wire.method === "GET" && wire.url.endsWith("/documents"))).toHaveLength(2),
    );
  });

  it("shows the delete guard's 409 verbatim, keeps the row and does not retry", async () => {
    const SAID =
      'Document "d1" is ingested; retract it with POST /documents/d1/retract before deleting it';
    const { client, seen } = removalClient((wire) =>
      wire.method === "POST" && wire.url === RETRACT_PATH
        ? jsonResponse({ error: "document_ingested", message: SAID }, 409)
        : undefined,
    );

    render(<StackPanel client={client} stackId="A" />);
    fireEvent.click(await removeButton());

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SAID));
    // The document fact, never the concurrency lock's sentence.
    expect(screen.getByRole("alert").textContent).not.toContain("Another ingest is running");

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(retractions(seen)).toHaveLength(1);
    // A refusal removed nothing: the row is still listed.
    expect(screen.getByText("contrato.pdf")).toBeDefined();
    expect(screen.queryByText("No documents uploaded yet.")).toBeNull();
  });

  it("shows 'there is nothing to retract' verbatim, keeps the row and does not retry", async () => {
    // The refusal the endpoint really answers when this Stack has no ingest of these
    // bytes. Its sentence is the answer — a paraphrase would drop the fact — and it must
    // not arrive as the concurrency lock's retry advice.
    const SAID = 'Document "d1" has no ingest recorded in Stack "A"; there is nothing to retract';
    const { client, seen } = removalClient((wire) =>
      wire.method === "POST" && wire.url === RETRACT_PATH
        ? jsonResponse({ error: "document_not_ingested", message: SAID }, 409)
        : undefined,
    );

    render(<StackPanel client={client} stackId="A" />);
    fireEvent.click(await removeButton());

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SAID));
    expect(screen.getByRole("alert").textContent).not.toContain("Another ingest is running");

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(retractions(seen)).toHaveLength(1);
    expect(screen.getByText("contrato.pdf")).toBeDefined();
  });

  it("shows an unavailable deployment's 503 verbatim, keeps the row and does not retry", async () => {
    // The LIVE behaviour of a deployment with SOURCE_RETRACTION_ENABLED off. What the
    // operator reads must be the server's sentence, which names the variable — not this
    // client's "the ingest service does not track jobs", which reports a different gap and
    // offers no way forward.
    const SAID =
      "source retraction is not enabled in this deployment: set SOURCE_RETRACTION_ENABLED=true " +
      "to let the wiki delete a compiled source and recompile without it";
    const { client, seen } = removalClient((wire) =>
      wire.method === "POST" && wire.url === RETRACT_PATH
        ? jsonResponse({ error: "source_retraction_unavailable", message: SAID }, 503)
        : undefined,
    );

    render(<StackPanel client={client} stackId="A" />);
    fireEvent.click(await removeButton());

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SAID));
    expect(screen.getByRole("alert").textContent).toContain("SOURCE_RETRACTION_ENABLED");
    expect(screen.getByRole("alert").textContent).not.toContain("does not track jobs");

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(retractions(seen)).toHaveLength(1);
    expect(screen.getByText("contrato.pdf")).toBeDefined();
  });

  it("disables the control while its request is in flight, so a second click is not a request", async () => {
    const { client, seen, release } = gatedRemovalClient();

    render(<StackPanel client={client} stackId="A" />);
    fireEvent.click(await removeButton());

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Delete contrato.pdf" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    // The visible words name the request that is out, like the job controls' do.
    expect(screen.getByRole("button", { name: "Delete contrato.pdf" }).textContent).toBe("Removing…");
    fireEvent.click(screen.getByRole("button", { name: "Delete contrato.pdf" }));

    release(jsonResponse({ jobId: "job_retract_9" }, 202));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Delete contrato.pdf" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );

    expect(retractions(seen)).toHaveLength(1);
  });

  it("keeps the accessible name stable while the visible words say what it does", async () => {
    // Two literals on purpose: the owner approved the visible change AND asked for the key
    // to stay, so `Delete <filename>` is the accessible name every other case addresses
    // this control by, and `Remove from wiki` is what a person reads. Pinned together so
    // they cannot drift apart silently.
    const { client } = removalClient((wire) =>
      wire.method === "POST" && wire.url === RETRACT_PATH
        ? jsonResponse({ jobId: "job_retract_1" }, 202)
        : undefined,
    );

    render(<StackPanel client={client} stackId="A" />);
    const button = await removeButton();

    expect(button.getAttribute("aria-label")).toBe("Delete contrato.pdf");
    expect(button.textContent).toBe("Remove from wiki");
  });

  it("carries no legacy identity header on the retraction or on the reads beside it", async () => {
    const { client, seen } = removalClient((wire) =>
      wire.method === "POST" && wire.url === RETRACT_PATH
        ? jsonResponse({ jobId: "job_retract_1" }, 202)
        : undefined,
    );

    render(<StackPanel client={client} stackId="A" />);
    fireEvent.click(await removeButton());
    await waitFor(() => expect(retractions(seen)).toHaveLength(1));

    expect(seen.length).toBeGreaterThan(0);
    for (const wire of seen) {
      expect(wire.headers["x-user-id"]).toBeUndefined();
      expect(wire.headers["x-dev-token"]).toBeUndefined();
    }
  });
});

/**
 * The controls over the REAL hook and the REAL client, with only the transport stubbed.
 *
 * A mocked `deleteJob` proves the button is wired; it cannot prove that a `409` reaches
 * the screen in the host's words, nor that deleting the followed job leaves the detail
 * pane empty. Those are the two facts an operator depends on, so they are driven end to
 * end here.
 */
describe("IngestJobsPanel: operator controls end to end", () => {
  const LISTED = SETTLED_JOB;

  /** A transport whose list holds one job, whose poll keeps it running, and whose DELETE answers as told. */
  function operatorClient(del: Response) {
    return stackingClient(({ method, url }) => {
      if (method === "DELETE") return del;
      if (method === "GET" && /\/ingest\/jobs\/[^?]+/.test(url)) {
        return jsonResponse({ ...LISTED, ingest: { status: "running", stage: "committing", attempts: [] } });
      }
      if (method === "GET" && /\/ingest\/jobs(\?|$)/.test(url)) {
        return jsonResponse({ jobs: [LISTED] });
      }
      return undefined;
    });
  }

  async function openTheJob() {
    fireEvent.click(await screen.findByText(/Source saved/));
    return screen.findByRole("button", { name: /Delete job/ });
  }

  it("renders the host's own 409 refusal verbatim, and sends the delete once", async () => {
    const { client, seen } = operatorClient(
      jsonResponse(
        {
          error: {
            code: "job_still_working",
            message: "job job_1 is still working; it was not deleted.",
          },
        },
        409,
      ),
    );

    render(<StackPanel client={client} stackId="A" />);
    const del = await openTheJob();
    fireEvent.click(del);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("job_still_working"),
    );
    // The service's sentence too, not just its code: "it was not deleted" is the answer.
    expect(screen.getByRole("alert").textContent).toContain("it was not deleted");

    // One click, one request. A refusal is not something to hammer.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen.filter((wire) => wire.method === "DELETE")).toHaveLength(1);
    // And the job is still on screen: a refused delete changed nothing.
    expect(screen.getByRole("button", { name: /Delete job job_1/ })).toBeDefined();
  });

  it("deleting the followed job leaves no spinner and no stale detail", async () => {
    const { client, seen } = operatorClient(new Response(null, { status: 204 }));

    render(<StackPanel client={client} stackId="A" />);
    const del = await openTheJob();

    // A live job paints the following spinner; the delete has to take it away with it.
    await waitFor(() => expect(screen.getByText("Updating automatically…")).toBeDefined());

    fireEvent.click(del);

    await waitFor(() =>
      expect(screen.getByText(/Start an ingest, or pick a job from the list to follow it/)).toBeDefined(),
    );
    expect(screen.queryByText("Updating automatically…")).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete job/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Ingest job job_1" })).toBeNull();

    // The request carried the link's Stack in the query, like every other ingest call.
    const deletes = seen.filter((wire) => wire.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toBe("/api/ingest/jobs/job_1?stackId=A");
  });

  it("retries the job on screen and follows the job the answer names", async () => {
    const { client, seen } = stackingClient(({ method, url }) => {
      if (method === "POST" && url.includes("/retry")) return jsonResponse({ jobId: "job_2" }, 202);
      if (method === "GET" && /\/ingest\/jobs\/[^?]+/.test(url)) return jsonResponse(SETTLED_JOB);
      if (method === "GET" && /\/ingest\/jobs(\?|$)/.test(url)) return jsonResponse({ jobs: [LISTED] });
      return undefined;
    });

    render(<StackPanel client={client} stackId="A" />);
    await openTheJob();
    const retry = screen.getByRole("button", { name: /Retry job/ });
    fireEvent.click(retry);

    // The NEW job is the one watched: it is the one that will make progress.
    await waitFor(() =>
      expect(seen.some((wire) => wire.url === "/api/ingest/jobs/job_2?stackId=A")).toBe(true),
    );
    const retries = seen.filter((wire) => wire.method === "POST" && wire.url.includes("/retry"));
    expect(retries).toHaveLength(1);
    expect(retries[0]!.url).toBe("/api/ingest/jobs/job_1/retry?stackId=A");
  });
});

/**
 * THE PANEL TELLS THE HOOK IT IS ON SCREEN
 *
 * The hook lives above the view switch, on purpose: a follow must survive a trip to the
 * chat tab. That is exactly why the interval refresh cannot live on the hook's own mount —
 * it would keep reading a list nobody is looking at. The panel is the thing that knows when
 * the surface is open, so it says so, and says so again on the way out (S5 of
 * `odd/tasks/ingest-follow-resilience.md`).
 *
 * Asserted on the wiring rather than on a timer: the interval itself is proven in
 * `web/src/lib/use-ingest.test.tsx` with an injected length, and re-proving it here would
 * mean waiting five real seconds for the same statement.
 */
describe("IngestJobsPanel: it announces itself as live while it is open", () => {
  it("sets the list live on mount and off on unmount", () => {
    const setListLive = vi.fn();
    const { unmount } = render(
      <IngestJobsPanel ingest={fakeIngest({ setListLive })} onClose={() => {}} />,
    );

    expect(setListLive).toHaveBeenCalledWith(true);

    unmount();
    expect(setListLive).toHaveBeenLastCalledWith(false);
  });

  it("still announces itself on the blocked surface, so the choice can be acted on", () => {
    // The blocked panel renders a different tree, but it is the same open surface: one
    // wiring at the top of the component, not one per branch.
    const setListLive = vi.fn();
    render(
      <IngestJobsPanel
        ingest={fakeIngest({ setListLive, blockedProblem: "This page needs a stackId in the link." })}
        onClose={() => {}}
      />,
    );

    expect(setListLive).toHaveBeenCalledWith(true);
  });
});
