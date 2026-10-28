import { describe, it, expect, vi } from "vitest";
import {
  describeJob,
  isJobSettled,
  nextPollDelay,
  pollJob,
  compileRetryable,
  POLL_INITIAL_MS,
  POLL_MAX_MS,
  stageLabel,
  type IngestJob,
} from "./ingest.ts";

/**
 * WHY THESE ASSERTIONS
 *
 * The UI's honesty depends on four rules that are easy to break silently:
 *
 *   1. A job is settled only when BOTH dimensions are terminal. Stopping early
 *      freezes the screen on work that is still happening.
 *   2. `503` and `404` lead to different outcomes. Merging them makes the UI
 *      declare a live job dead.
 *   3. The backoff is 250 ms -> 2 s and no faster. Polling a compile every 250 ms
 *      for ten minutes is a self-inflicted load problem.
 *   4. `busy` is not a failure, and `unchanged` is not `succeeded`.
 */

function job(overrides: Partial<IngestJob> = {}): IngestJob {
  return {
    id: "ing_1",
    source: "https://example.com/a",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ingest: { status: "running", stage: "fetching", attempts: [] },
    compile: { status: "queued", progress: null },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A sleep that records the delays instead of waiting, so the curve is testable. */
function recordingSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("settling", () => {
  it("does not consider a finished ingest a finished job", () => {
    // The exact state that looks done and is not.
    expect(
      isJobSettled(
        job({
          ingest: { status: "succeeded", stage: "journaling", attempts: [] },
          compile: { status: "running", stage: "page_generation", progress: null },
        }),
      ),
    ).toBe(false);
  });

  it("treats compile.busy as terminal, because the source is already on disk", () => {
    expect(
      isJobSettled(
        job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "busy", progress: null },
        }),
      ),
    ).toBe(true);
  });

  it("treats ingest.unchanged as terminal but keeps it distinct from succeeded", () => {
    const unchanged = job({
      ingest: { status: "unchanged", attempts: [] },
      compile: { status: "skipped", progress: null },
    });
    expect(isJobSettled(unchanged)).toBe(true);
    expect(describeJob(unchanged)).toContain("Unchanged");

    const succeeded = job({
      ingest: { status: "succeeded", attempts: [] },
      compile: { status: "skipped", progress: null },
    });
    expect(describeJob(succeeded)).toContain("Source saved");
    expect(describeJob(succeeded)).not.toEqual(describeJob(unchanged));
  });

  it("keeps a busy compile out of the failure vocabulary", () => {
    const busy = job({
      ingest: { status: "succeeded", attempts: [] },
      compile: { status: "busy", progress: null },
    });
    expect(describeJob(busy)).not.toMatch(/failed/i);
    expect(describeJob(busy)).toMatch(/retry the compile/i);
    expect(compileRetryable(busy.compile)).toBe(true);
  });

  it("does not offer a compile retry after one succeeded", () => {
    expect(compileRetryable({ status: "succeeded", progress: null })).toBe(false);
    expect(compileRetryable({ status: "skipped", progress: null })).toBe(false);
    expect(compileRetryable({ status: "failed", progress: null })).toBe(true);
  });

  it("names which half is moving instead of reporting one status", () => {
    expect(
      describeJob(
        job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "running", stage: "finalize", progress: null },
        }),
      ),
    ).toMatch(/compiling · finalizing/);
  });
});

describe("stages", () => {
  it("renders the pipeline's own stage names", () => {
    expect(stageLabel("page_generation")).toBe("generating pages");
    expect(stageLabel("detect_changes")).toBe("detecting changes");
  });

  it("shows an unknown stage as itself rather than hiding it", () => {
    expect(stageLabel("some_future_stage")).toBe("some_future_stage");
  });

  it("says 'waiting' when no stage is reported yet", () => {
    expect(stageLabel(undefined)).toBe("waiting");
  });
});

describe("backoff", () => {
  it("doubles from 250 ms and stops at 2 s", () => {
    expect(POLL_INITIAL_MS).toBe(250);
    expect(POLL_MAX_MS).toBe(2_000);
    let delay = POLL_INITIAL_MS;
    const seen = [delay];
    for (let i = 0; i < 6; i += 1) {
      delay = nextPollDelay(delay);
      seen.push(delay);
    }
    expect(seen).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000, 2_000]);
  });

  it("polls on that curve until the job settles", async () => {
    const snapshots = [
      job({ ingest: { status: "queued", attempts: [] }, compile: { status: "queued", progress: null } }),
      job({ ingest: { status: "running", stage: "committing", attempts: [] }, compile: { status: "queued", progress: null } }),
      job({ ingest: { status: "running", stage: "projecting", attempts: [] }, compile: { status: "queued", progress: null } }),
      job({ ingest: { status: "succeeded", attempts: [] }, compile: { status: "running", stage: "page_generation", progress: { completed: 1, total: 3 } } }),
      job({ ingest: { status: "succeeded", attempts: [] }, compile: { status: "succeeded", stage: "finalize", progress: { completed: 3, total: 3 } } }),
    ];
    let index = 0;
    const fetchMock = vi.fn(async () => jsonResponse(snapshots[Math.min(index++, snapshots.length - 1)]));
    const { delays, sleep } = recordingSleep();
    const updates: IngestJob[] = [];

    const outcome = await pollJob("ing_1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: () => ({ "x-dev-token": "t" }),
      onUpdate: (j) => updates.push(j),
      sleep,
    });

    expect(outcome.reason).toBe("settled");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // Four waits between five reads: the last read settles, so it does not wait.
    expect(delays).toEqual([250, 500, 1_000, 2_000]);
    expect(updates).toHaveLength(5);
    // The exact progress pair survives untouched: nothing was recomputed.
    expect(updates[3]?.compile.progress).toEqual({ completed: 1, total: 3 });
  });

  it("stops on the first read when the job already settled", async () => {
    const settled = job({
      ingest: { status: "succeeded", attempts: [] },
      compile: { status: "succeeded", progress: null },
    });
    const fetchMock = vi.fn(async () => jsonResponse(settled));
    const { delays, sleep } = recordingSleep();

    const outcome = await pollJob("ing_1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: () => ({}),
      onUpdate: () => {},
      sleep,
    });

    expect(outcome.reason).toBe("settled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});

describe("stop reasons that are not failures", () => {
  it("reports 503 as an unavailable host, and says so in words", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code: "jobs_unavailable" } }, 503));
    const outcome = await pollJob("ing_1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: () => ({}),
      onUpdate: () => {},
      sleep: async () => {},
    });

    expect(outcome.reason).toBe("unavailable");
    expect(outcome.message).toMatch(/does not track ingest jobs/);
  });

  it("reports 404 as an expired/unknown job, with the retention window named", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code: "job_not_found" } }, 404));
    const outcome = await pollJob("ing_1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: () => ({}),
      onUpdate: () => {},
      sleep: async () => {},
    });

    expect(outcome.reason).toBe("unknown");
    expect(outcome.message).toMatch(/one hour/);
    // The two reasons must never be the same outcome.
    expect(outcome.reason).not.toBe("unavailable");
  });

  it("keeps the last snapshot when the job disappears", async () => {
    let call = 0;
    const running = job();
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1 ? jsonResponse(running) : jsonResponse({ error: { code: "job_not_found" } }, 404);
    });

    const outcome = await pollJob("ing_1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: () => ({}),
      onUpdate: () => {},
      sleep: async () => {},
    });

    expect(outcome.reason).toBe("unknown");
    expect(outcome.job?.ingest.stage).toBe("fetching");
  });

  it("stops when aborted instead of polling a cancelled view", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return jsonResponse(job());
    });
    const { delays, sleep } = recordingSleep();

    const outcome = await pollJob("ing_1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: () => ({}),
      onUpdate: () => {},
      sleep,
      signal: controller.signal,
    });

    expect(outcome.reason).toBe("aborted");
    expect(delays).toEqual([]);
  });
});
