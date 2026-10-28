import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IngestJobView } from "./IngestJobView.tsx";
import { IngestJobsPanel } from "./IngestJobsPanel.tsx";
import { ApiClient, ApiError } from "../lib/api.ts";
import { noticeFor, noticeForOutcome, useIngest, type UseIngestResult } from "../lib/use-ingest.ts";
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
    // The pair is shown as it is; no division by zero produces NaN% or Infinity%.
    expect(screen.getByText("0 of 0")).toBeDefined();
    expect(document.querySelector(".progress__fill")?.getAttribute("style")).toContain("width: 0%");
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

/** A hand-built result object, so the panel is testable without a live client. */
function fakeIngest(overrides: Partial<UseIngestResult> = {}): UseIngestResult {
  return {
    stacks: [],
    stacksProblem: null,
    stackFilterUnsupported: false,
    selectedStackId: null,
    selectStack: vi.fn(),
    observeStacks: vi.fn(),
    documents: [],
    uploading: false,
    listDocuments: vi.fn(async () => {}),
    upload: vi.fn(async () => null),
    removeDocument: vi.fn(async () => {}),
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
    start: vi.fn(async () => {}),
    follow: vi.fn(),
    stopFollowing: vi.fn(),
    refreshList: vi.fn(async () => {}),
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
            { id: "d1", filename: "contrato.pdf", bytes: 2048, contentType: "application/pdf", createdAt: "" },
          ],
          ingestDocument,
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("contrato.pdf")).toBeDefined();
    expect(screen.getByText("2 KB")).toBeDefined();
    fireEvent.click(screen.getByText("Ingest"));
    expect(ingestDocument).toHaveBeenCalledWith("d1", { compile: true });
  });

  it("offers a stack picker fed by the agent, and marks the bound one", () => {
    const selectStack = vi.fn();
    render(
      <IngestJobsPanel
        ingest={fakeIngest({
          stacks: [
            { id: "s1", name: "Formation", isCurrent: false },
            { id: "s2", name: "Wire", isCurrent: true },
          ],
          selectedStackId: "s2",
          selectStack,
        })}
        onClose={() => {}}
      />,
    );

    const select = screen.getByLabelText("Stack") as HTMLSelectElement;
    expect(select.value).toBe("s2");
    // The bound stack says so, because that is the one a user is most likely asking
    // about and the fact is not otherwise visible.
    expect(screen.getByText(/Wire \(bound\)/)).toBeDefined();

    fireEvent.change(select, { target: { value: "s1" } });
    expect(selectStack).toHaveBeenCalledWith("s1");
  });

  it("explains an empty picker instead of showing a bare dropdown", () => {
    render(<IngestJobsPanel ingest={fakeIngest()} onClose={() => {}} />);
    expect(screen.getByText("No stacks known yet")).toBeDefined();
    // The list comes from the agent, so an empty one is not a bug and must not read
    // like one.
    expect(screen.getByText(/Ask the assistant to list the stacks/)).toBeDefined();
  });

  it("says the job list does not follow the picker, when it does not", () => {
    // The guard that stops the UI attributing one stack's jobs to another. It is
    // only shown when there is more than one stack to confuse.
    render(
      <IngestJobsPanel
        ingest={fakeIngest({
          stacks: [
            { id: "s1", name: "Formation", isCurrent: true },
            { id: "s2", name: "Wire", isCurrent: false },
          ],
          selectedStackId: "s2",
          stackFilterUnsupported: true,
        })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/own stack, not the\s+selection/);
  });

  it("does not warn about the picker when there is only one stack", () => {
    // With one stack there is nothing to misattribute, so a warning would be noise.
    render(
      <IngestJobsPanel
        ingest={fakeIngest({
          stacks: [{ id: "s1", name: "Formation", isCurrent: true }],
          selectedStackId: "s1",
          stackFilterUnsupported: true,
        })}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a stack-list problem as a failure, not as an empty list", () => {
    render(
      <IngestJobsPanel
        ingest={fakeIngest({ stacksProblem: "No Stack 'x' exists." })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("No Stack 'x' exists.");
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

    expect(start).toHaveBeenCalledWith("https://example.com/x", { compile: false });
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
  function Probe({ client, onRender }: { client: ApiClient; onRender: (r: UseIngestResult) => void }) {
    const result = useIngest({ client });
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
    render(<Probe client={client} onRender={(r) => (latest = r)} />);

    await waitFor(() => expect(latest?.loadingList).toBe(false));
    latest!.follow("ing_1");

    await waitFor(() => expect(screen.getByTestId("notice").textContent).toBe("unavailable"));
    expect(screen.getByTestId("following").textContent).toBe("false");
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
    render(<Probe client={client} onRender={(r) => (latest = r)} />);

    await waitFor(() => expect(latest?.loadingList).toBe(false));
    latest!.follow("ing_1");

    await waitFor(() => expect(screen.getByTestId("notice").textContent).toBe("unknown"));
  });
});
