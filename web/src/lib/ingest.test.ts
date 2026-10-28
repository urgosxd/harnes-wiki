import { describe, it, expect, vi } from "vitest";
import {
  describeJob,
  isUnchanged,
  MISSING_TOLERANCE,
  STALL_AFTER_MS,
  isJobSettled,
  nextPollDelay,
  pollJob,
  compileRetryable,
  compileBlockedByIngestFailure,
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
    expect(compileRetryable(busy)).toBe(true);
  });

  it("does not offer a compile retry when there is nothing to retry", () => {
    const withCompile = (status: "succeeded" | "skipped" | "failed") =>
      job({
        ingest: { status: "succeeded", attempts: [] },
        compile: { status, progress: null },
      });
    expect(compileRetryable(withCompile("succeeded"))).toBe(false);
    expect(compileRetryable(withCompile("skipped"))).toBe(false);
    expect(compileRetryable(withCompile("failed"))).toBe(true);
  });

  it("does NOT claim the source is saved when the ingest failed", () => {
    // Found in a live run against real jobs, not in this suite: a lock-contention
    // failure reports `ingest: failed` with `compile: busy` and the service's own
    // message "Compile did not start". Checking the compile status alone made the UI
    // print "The source is saved. Only the compile needs a retry." directly beneath a
    // message saying the compile never started — two sentences contradicting each
    // other, and the wrong one told the user their file was safe.
    const lockFailure = job({
      ingest: {
        status: "failed",
        attempts: [],
        error: "Another mutation holds the project lock; retry.",
      },
      compile: {
        status: "busy",
        progress: null,
        message: "Compile did not start: another mutation held the project lock.",
      },
    });
    expect(compileRetryable(lockFailure)).toBe(false);
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

  it("stops when a snapshot stops advancing, instead of polling forever", async () => {
    // The case the service's persistence makes reachable: a process killed mid-job
    // leaves its last snapshot frozen. Nothing will ever finish it, and a poller
    // without this check spins for as long as the tab stays open.
    const frozen = job({
      ingest: { status: "running", stage: "committing", attempts: [] },
      compile: { status: "queued", progress: null },
    });
    const fetchMock = vi.fn(async () => jsonResponse(frozen));
    const { delays, sleep } = recordingSleep();

    const outcome = await pollJob("ing_1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: () => ({}),
      onUpdate: () => {},
      sleep,
      // A real duration, so the check is exercised rather than mocked away.
      stallAfterMs: 0,
    });

    expect(outcome.reason).toBe("stalled");
    // It DID return the last state: the UI can still show where it stopped.
    expect(outcome.job?.ingest.stage).toBe("committing");
    expect(outcome.message).toMatch(/stopped mid-way|not advanced|will not advance/);
    expect(delays.length).toBeLessThan(5);
  });

  it("keeps polling while the snapshot advances", async () => {
    // The mirror of the previous test: movement must never be misread as a stall.
    let tick = 0;
    const fetchMock = vi.fn(async () => {
      tick += 1;
      const done = tick >= 5;
      return jsonResponse(
        job({
          updatedAt: `2026-01-01T00:00:0${tick}.000Z`,
          // BOTH dimensions must settle: a job whose ingest keeps "running" is
          // still work in progress, and asserting otherwise would encode the very
          // mistake this suite exists to prevent.
          ingest: done
            ? { status: "succeeded", stage: "journaling", attempts: [] }
            : { status: "running", stage: "committing", attempts: [] },
          compile: done
            ? { status: "succeeded", progress: null }
            : { status: "queued", progress: null },
        }),
      );
    });
    const outcome = await pollJob("ing_1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: () => ({}),
      onUpdate: () => {},
      sleep: async () => {},
      // Zero tolerance for stalls, yet movement must still be tolerated.
      stallAfterMs: 0,
    });

    expect(outcome.reason).toBe("settled");
  });

  it("compares updatedAt, which every real transition rewrites", () => {
    const a = job({ updatedAt: "2026-01-01T00:00:01.000Z" });
    const b = job({ updatedAt: "2026-01-01T00:00:02.000Z" });
    expect(isUnchanged(undefined, a)).toBe(false);
    expect(isUnchanged(a, a)).toBe(true);
    expect(isUnchanged(a, b)).toBe(false);
    expect(STALL_AFTER_MS).toBeGreaterThan(2_000);
  });

  it("tolerates an early 404, because a foreign Stack's mirror can lag", async () => {
    // A foreign-Stack read is durable-only and the mirror write is fire-and-forget,
    // so a job started a moment ago can be missing for a tick. Reporting it as
    // expired on the first read would call a running job gone.
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call <= 2) return jsonResponse({ error: { code: "job_not_found" } }, 404);
      return jsonResponse(
        job({
          ingest: { status: "succeeded", attempts: [] },
          compile: { status: "skipped", progress: null },
        }),
      );
    });
    const { delays, sleep } = recordingSleep();

    const outcome = await pollJob("ing_1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: () => ({}),
      onUpdate: () => {},
      sleep,
    });

    expect(outcome.reason).toBe("settled");
    expect(call).toBe(3);
    // It waited rather than stopping: three reads means two tolerated 404s.
    expect(delays).toEqual([250, 500]);
  });

  it("still reports expired when the 404 persists past the tolerance", async () => {
    // The bound on the tolerance: an unbounded one would make an expired job look
    // like a slow one forever.
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code: "job_not_found" } }, 404));
    const outcome = await pollJob("ing_1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: () => ({}),
      onUpdate: () => {},
      sleep: async () => {},
    });

    expect(outcome.reason).toBe("unknown");
    expect(outcome.message).toMatch(/one hour/);
    // Exactly tolerance+1 reads before giving up.
    expect((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      MISSING_TOLERANCE + 1,
    );
  });

  it("does not tolerate a 404 once a snapshot has arrived", async () => {
    // A job seen and then dropped is expired, not late.
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(job());
      return jsonResponse({ error: { code: "job_not_found" } }, 404);
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

describe("compileBlockedByIngestFailure", () => {
  const base = {
    id: "ing_x",
    source: "/tmp/x.md",
    createdAt: "2026-10-28T19:31:06.447Z",
    updatedAt: "2026-10-28T19:31:06.448Z",
  };

  it("is true for the exact shape the live service leaves behind", () => {
    // Copied from a real job: a source that does not exist fails the ingest and the
    // service leaves the compile at `queued` with a frozen updatedAt forever. Nothing
    // will ever start it, so an animated "Working" bar would be a lie about motion.
    const job = {
      ...base,
      ingest: {
        status: "failed" as const,
        attempts: [],
        stage: "fetching" as const,
        endedAt: "2026-10-28T19:31:06.448Z",
        error: "ENOENT: no such file or directory, open '/tmp/x.md'",
      },
      compile: { status: "queued" as const, progress: null },
    };
    expect(compileBlockedByIngestFailure(job)).toBe(true);
  });

  it("is true for the settled shape the service now reports", () => {
    // The service changed under my feet and the change is visible here: after the peer
    // fixed the frozen state upstream, a failed ingest now settles the compile as
    // `skipped` with its own message instead of leaving it `queued` forever. Both
    // shapes mean the same thing, so the guard covers both — a UI pinned to the old
    // shape would have started animating again the moment the fix landed.
    const job = {
      ...base,
      ingest: { status: "failed" as const, attempts: [] },
      compile: {
        status: "skipped" as const,
        progress: null,
        message: "Compile never started: the ingest failed, so there was nothing to compile.",
      },
    };
    expect(compileBlockedByIngestFailure(job)).toBe(true);
  });

  it("is false for a compile skipped ON REQUEST after a successful ingest", () => {
    // `skipped` alone does NOT mean blocked: the service also reports it when the
    // caller asked not to compile. The discriminator is the ingestion outcome, not
    // the compile status, and testing only `skipped` would have conflated two
    // opposite situations into one message.
    const job = {
      ...base,
      ingest: { status: "succeeded" as const, attempts: [] },
      compile: {
        status: "skipped" as const,
        progress: null,
        message: "Compile skipped on request.",
      },
    };
    expect(compileBlockedByIngestFailure(job)).toBe(false);
  });

  it("is false for a healthy queued job, which really is about to run", () => {
    const job = {
      ...base,
      ingest: { status: "running" as const, attempts: [], stage: "fetching" as const },
      compile: { status: "queued" as const, progress: null },
    };
    expect(compileBlockedByIngestFailure(job)).toBe(false);
  });
});
