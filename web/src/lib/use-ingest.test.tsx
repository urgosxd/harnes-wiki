import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ApiClient } from "./api.ts";
import type { IngestJob } from "./ingest.ts";
import { POLL_MAX_MS, pollJob } from "./ingest.ts";
import { noticeForOutcome, useIngest } from "./use-ingest.ts";

/**
 * WHY THESE ASSERTIONS
 *
 * The defect behind them is invisible from the rendered panels: `start` and
 * `ingestDocument` spread the link's stackId AFTER the caller's options, so a Stack
 * chosen for the call was discarded with no error and no notice — the request simply
 * went to the other tenant. The only place that difference exists is the request
 * body, so every test here reads the wire. Nothing asserts hook internals.
 *
 * The rule they pin is the product rule: a Stack chosen for the call wins (S3), the
 * link's stackId is the fallback (S2), and when neither answers the hook sends
 * nothing and says which two sources were empty (S4) instead of writing into a
 * tenant nobody named.
 */

/** The exact copy the S4 notice must carry: it names both empty sources and the fix. */
const UNRESOLVED_NOTICE_TEXT =
  "This ingest names no Stack: no Stack was chosen for it and the link names none. " +
  "Choose a Stack, or open a link that ends in ?stackId=<stack-id>.";

interface Recorded {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SETTLED_JOB = {
  id: "job_1",
  source: "https://example.com/a",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ingest: { status: "succeeded", stage: "stored", attempts: [] },
  compile: { status: "succeeded", stage: "compiled", progress: null },
};

/**
 * A real ApiClient over a stubbed transport, so the body under test is the one the
 * client actually serializes rather than an argument to a mocked method.
 */
function harness() {
  const seen: Recorded[] = [];
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
    });
    if (method === "POST" && href.endsWith("/ingest/jobs")) {
      return json(
        {
          jobId: SETTLED_JOB.id,
          status: "queued",
          stage: "queued",
          ingest: SETTLED_JOB.ingest,
          compile: SETTLED_JOB.compile,
        },
        202,
      );
    }
    // The poll answers an already settled job, so the follow loop stops on its first
    // read instead of scheduling timers a test would have to clean up.
    if (href.includes("/ingest/jobs/")) return json(SETTLED_JOB);
    if (href.endsWith("/documents")) return json({ documents: [] });
    return json({ jobs: [] });
  }) as unknown as typeof fetch;

  const client = new ApiClient({
    baseUrl: "/api",
    headers: () => ({ "x-stack-id": "from-headers" }),
    fetchImpl,
  });

  return { seen, client, posts: () => seen.filter((r) => r.method === "POST") };
}

async function renderIngest(stackId: string | null) {
  const h = harness();
  const view = renderHook(() => useIngest({ client: h.client, stackId }));
  await waitFor(() => expect(view.result.current.loadingList).toBe(false));
  return { ...h, view };
}

describe("useIngest effective stackId", () => {
  it("sends the Stack chosen for the call instead of the link's (S3)", async () => {
    const { posts, view } = await renderIngest("A");

    await act(async () => {
      await view.result.current.start("https://example.com/a", { stackId: "B" });
    });

    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toEqual({
      source: "https://example.com/a",
      compile: true,
      stackId: "B",
    });
    await waitFor(() => expect(view.result.current.following).toBe(false));
  });

  it("sends the Stack chosen for the call when ingesting a document (S3)", async () => {
    const { posts, view } = await renderIngest("A");

    await act(async () => {
      await view.result.current.ingestDocument("d1", { stackId: "B" });
    });

    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toEqual({
      documentId: "d1",
      compile: true,
      stackId: "B",
    });
    await waitFor(() => expect(view.result.current.following).toBe(false));
  });

  it("falls back to the link's Stack when the call chooses none (S2)", async () => {
    const { posts, view } = await renderIngest("A");

    await act(async () => {
      await view.result.current.start("https://example.com/a");
    });

    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toEqual({
      source: "https://example.com/a",
      compile: true,
      stackId: "A",
    });
    await waitFor(() => expect(view.result.current.following).toBe(false));
  });

  it("keeps the chosen Stack out of the reads that belong to the link's scope (S3)", async () => {
    // The choice scopes the ingest that was started with it. It must not silently
    // retarget the job list or another Stack's poll: those reads are the link's
    // tenant, and a choice leaking into them would show one Stack's jobs as if they
    // were another's.
    const { seen, view } = await renderIngest("A");

    act(() => view.result.current.chooseStackId("B"));
    await act(async () => {
      await view.result.current.refreshList();
    });
    act(() => view.result.current.follow("job_1"));
    await waitFor(() => expect(view.result.current.following).toBe(false));

    const reads = seen.filter((record) => record.method === "GET");
    expect(reads.some((record) => record.url.includes("stackId=B"))).toBe(false);
    expect(reads.some((record) => record.url.includes("/ingest/jobs?stackId=A"))).toBe(true);
    expect(reads.some((record) => record.url.includes("/ingest/jobs/job_1?stackId=A"))).toBe(true);
  });

  it("sends nothing and says why when neither the call nor the link names a Stack (S4)", async () => {
    const { seen, view } = await renderIngest(null);

    // `GET /stacks` is the one request allowed in this state, and it is not a tenant
    // read: it is the list of choices S4 tells the user to pick from, so it cannot
    // itself depend on knowing a Stack. Every tenant-scoped call stays at zero.
    const tenantRequests = () => seen.filter((record) => !record.url.endsWith("/stacks"));

    await act(async () => {
      await view.result.current.start("https://example.com/a");
    });

    expect(tenantRequests()).toEqual([]);
    expect(view.result.current.pollNotice).toEqual({
      kind: "error",
      message: UNRESOLVED_NOTICE_TEXT,
    });

    // The document path is the same rule, not a second one.
    await act(async () => {
      await view.result.current.ingestDocument("d1");
    });

    expect(tenantRequests()).toEqual([]);
    expect(view.result.current.pollNotice).toEqual({
      kind: "error",
      message: UNRESOLVED_NOTICE_TEXT,
    });
  });
});

/**
 * WHAT THESE ASSERTIONS PIN
 *
 * The operator controls are one click, one request, one visible answer. The failures
 * that would be invisible from the panel are all on the wire or in the hook's public
 * state, so that is what is asserted:
 *
 *   - a delete must reach `DELETE /ingest/jobs/:id?stackId=` and then REFRESH the list,
 *     because a deleted job that stays in the list is a lie the next reload corrects;
 *   - deleting the job being watched must end the poll and clear the detail, or the
 *     panel keeps a spinner for something that no longer exists;
 *   - a retry creates a NEW job, so the follow has to move to the id in the body
 *     (`jobId` or `id`) — following the old one shows a job that was not retried;
 *   - a `409` is the host's ANSWER (`job_still_working`), not a transport failure, so
 *     its own code and words have to survive into the notice, once;
 *   - with no resolved Stack nothing is sent at all, exactly like every other write.
 */

function isoJob(id: string, status: "running" | "succeeded"): IngestJob {
  return {
    id,
    source: "https://example.com/a",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ingest: { status, stage: "committing", attempts: [] },
    compile: status === "running" ? { status: "queued", progress: null } : { status: "succeeded", progress: null },
  };
}

interface Call {
  method: string;
  url: string;
}

/** The id a `/ingest/jobs/:id` URL names. */
function idIn(url: string): string {
  return decodeURIComponent(url.split("/ingest/jobs/")[1]!.split("?")[0]!.replace(/\/retry$/, ""));
}

/**
 * A real client over a recording transport.
 *
 * `answer` gets first refusal, which is how one test answers a 409 and another keeps a
 * job running so "following" is observably true when the delete lands. Everything
 * else answers by shape: the poll returns whatever job the URL names, so a retry that
 * follows the WRONG id cannot pass by accident.
 */
function controlHarness(answer: (call: Call) => Response | undefined = () => undefined) {
  const seen: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const href = String(url);
    const call: Call = { method: init?.method ?? "GET", url: href };
    seen.push(call);

    const custom = answer(call);
    if (custom) return custom;

    if (call.method === "DELETE") return new Response(null, { status: 204 });
    if (call.method === "POST" && href.includes("/retry")) return json({ jobId: "job_new" }, 202);
    if (href.includes("/ingest/jobs/")) return json(isoJob(idIn(href), "succeeded"));
    if (href.endsWith("/stacks")) return json({ stackIds: ["A", "B"] });
    if (href.endsWith("/documents")) return json({ documents: [] });
    return json({ jobs: [isoJob("job_1", "succeeded")] });
  }) as unknown as typeof fetch;

  const client = new ApiClient({ baseUrl: "/api", headers: () => ({ "x-user-id": "u" }), fetchImpl });
  return {
    client,
    seen,
    deletes: () => seen.filter((call) => call.method === "DELETE"),
    retries: () => seen.filter((call) => call.method === "POST" && call.url.includes("/retry")),
    listReads: () => seen.filter((call) => call.method === "GET" && /\/ingest\/jobs(\?|$)/.test(call.url)),
    polls: () => seen.filter((call) => call.method === "GET" && call.url.includes("/ingest/jobs/")),
  };
}

describe("useIngest: delete a job", () => {
  it("sends DELETE for that id and Stack, then refreshes the list", async () => {
    const h = controlHarness();
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));
    const listsBefore = h.listReads().length;

    await act(async () => {
      await view.result.current.deleteJob("job_1");
    });

    expect(h.deletes()).toHaveLength(1);
    expect(h.deletes()[0]!.url).toBe("/api/ingest/jobs/job_1?stackId=A");
    // The list is re-read: a deleted row left on screen is a job the user would click
    // again and get a 404 from.
    expect(h.listReads().length).toBeGreaterThan(listsBefore);
    expect(view.result.current.pollNotice).toBeNull();
  });

  it("stops following and clears the detail when the deleted job was the active one", async () => {
    // The job stays `running`, so the poll is genuinely live when the delete lands —
    // otherwise `following === false` would be a fixture artefact rather than the
    // delete's effect.
    const h = controlHarness(({ url, method }) =>
      method === "GET" && url.includes("/ingest/jobs/job_1") ? json(isoJob("job_1", "running")) : undefined,
    );
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));

    act(() => view.result.current.follow("job_1"));
    await waitFor(() => expect(view.result.current.following).toBe(true));
    await waitFor(() => expect(view.result.current.activeId).toBe("job_1"));

    await act(async () => {
      await view.result.current.deleteJob("job_1");
    });

    expect(view.result.current.following).toBe(false);
    expect(view.result.current.activeId).toBeNull();
    expect(view.result.current.activeJob).toBeNull();
    // And the poll really stopped: no further read of the deleted job.
    const pollsOfDeleted = h.polls().filter((call) => call.url.includes("/ingest/jobs/job_1"));
    const countAfter = pollsOfDeleted.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.polls().filter((call) => call.url.includes("/ingest/jobs/job_1"))).toHaveLength(countAfter);
  });

  it("leaves the job being watched alone when a DIFFERENT job is deleted", async () => {
    const h = controlHarness(({ url, method }) =>
      method === "GET" && url.includes("/ingest/jobs/job_2") ? json(isoJob("job_2", "running")) : undefined,
    );
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));

    act(() => view.result.current.follow("job_2"));
    await waitFor(() => expect(view.result.current.following).toBe(true));

    await act(async () => {
      await view.result.current.deleteJob("job_1");
    });

    expect(view.result.current.activeId).toBe("job_2");
    expect(view.result.current.activeJob?.id).toBe("job_2");
    expect(view.result.current.following).toBe(true);
    view.result.current.stopFollowing();
    await waitFor(() => expect(view.result.current.following).toBe(false));
  });

  it("surfaces a 409 job_still_working in the host's words, once", async () => {
    const h = controlHarness(({ method }) =>
      method === "DELETE"
        ? json(
            {
              error: {
                code: "job_still_working",
                message: "job job_1 is still working; it was not deleted.",
              },
            },
            409,
          )
        : undefined,
    );
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));

    await act(async () => {
      await view.result.current.deleteJob("job_1");
    });

    const notice = view.result.current.pollNotice;
    expect(notice?.kind).toBe("error");
    // The refusal is the answer to show: the host's code and its sentence, not a
    // friendlier paraphrase and not a bare status code.
    expect(notice?.message).toContain("job_still_working");
    expect(notice?.message).toContain("still working");

    // One click, one request, one answer. Nothing repeats a rejection.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.deletes()).toHaveLength(1);
  });

  it("marks the id as in flight while its own request is out, and clears it after", async () => {
    // A transport whose DELETE hangs until the test releases it: the flag has to be true
    // while the request is genuinely outstanding, not merely after a render.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gatedFetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        await gate;
        return new Response(null, { status: 204 });
      }
      if (String(url).includes("/ingest/jobs/")) return json(isoJob(idIn(String(url)), "succeeded"));
      if (String(url).endsWith("/stacks")) return json({ stackIds: [] });
      if (String(url).endsWith("/documents")) return json({ documents: [] });
      return json({ jobs: [] });
    }) as unknown as typeof fetch;
    const gated = new ApiClient({ baseUrl: "/api", headers: () => ({ "x-user-id": "u" }), fetchImpl: gatedFetch });

    const view = renderHook(() => useIngest({ client: gated, stackId: "A" }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));

    let pending: Promise<void> | undefined;
    act(() => {
      pending = view.result.current.deleteJob("job_1");
    });
    await waitFor(() => expect(view.result.current.deletingIds.has("job_1")).toBe(true));
    expect(view.result.current.deletingIds.has("job_2")).toBe(false);

    await act(async () => {
      release?.();
      await pending;
    });
    expect(view.result.current.deletingIds.has("job_1")).toBe(false);
  });
});

describe("useIngest: retry a job", () => {
  it("follows the new id the body names as `jobId`, and refreshes the list", async () => {
    const h = controlHarness();
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));
    const listsBefore = h.listReads().length;

    await act(async () => {
      await view.result.current.retryJob("job_1");
    });

    expect(h.retries()).toHaveLength(1);
    expect(h.retries()[0]!.url).toBe("/api/ingest/jobs/job_1/retry?stackId=A");
    // The NEW job, not the one that was retried: it is a different job with its own
    // progress, and reading the old id would show a job nobody asked for.
    await waitFor(() => expect(view.result.current.activeId).toBe("job_new"));
    expect(h.polls().some((call) => call.url.includes("/ingest/jobs/job_new"))).toBe(true);
    expect(h.listReads().length).toBeGreaterThan(listsBefore);
    await waitFor(() => expect(view.result.current.following).toBe(false));
  });

  it("follows the new id when the body names it as `id` instead", async () => {
    const h = controlHarness(({ method, url }) =>
      method === "POST" && url.includes("/retry") ? json({ id: "job_alt" }, 202) : undefined,
    );
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));

    await act(async () => {
      await view.result.current.retryJob("job_1");
    });

    await waitFor(() => expect(view.result.current.activeId).toBe("job_alt"));
    expect(h.polls().some((call) => call.url.includes("/ingest/jobs/job_alt"))).toBe(true);
    await waitFor(() => expect(view.result.current.following).toBe(false));
  });

  it("surfaces a 409 from the retry in the host's words, and does not retry it", async () => {
    const h = controlHarness(({ method, url }) =>
      method === "POST" && url.includes("/retry")
        ? json(
            {
              error: {
                code: "job_still_working",
                message: "job job_1 is still working; it was not retried.",
              },
            },
            409,
          )
        : undefined,
    );
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));

    await act(async () => {
      await view.result.current.retryJob("job_1");
    });

    expect(view.result.current.pollNotice?.message).toContain("job_still_working");
    expect(view.result.current.activeId).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.retries()).toHaveLength(1);
  });
});

describe("useIngest: the controls without a resolved Stack", () => {
  it("sends nothing and says why, for both controls", async () => {
    const h = controlHarness();
    const view = renderHook(() => useIngest({ client: h.client, stackId: null }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));

    const tenantCalls = () => h.seen.filter((call) => !call.url.endsWith("/stacks"));

    await act(async () => {
      await view.result.current.deleteJob("job_1");
    });
    expect(tenantCalls()).toEqual([]);
    expect(view.result.current.pollNotice).toEqual({ kind: "error", message: UNRESOLVED_NOTICE_TEXT });

    await act(async () => {
      await view.result.current.retryJob("job_1");
    });
    expect(tenantCalls()).toEqual([]);
    expect(view.result.current.pollNotice).toEqual({ kind: "error", message: UNRESOLVED_NOTICE_TEXT });
  });
});

/**
 * The 409 branch is SHARED, and it answers two unrelated questions.
 *
 * `noticeFor` is one mapping for every ingest call. `job_still_working` and `job_changed`
 * are the host's answer about one job, and their own code and words reach the screen
 * (pinned above). The concurrency lock is a different fact on the same status: `start`
 * hitting an ingest that is already running is a RETRY SIGNAL, not a failure, and that
 * sentence existed before the operator controls did.
 *
 * The sentence is asserted literally, not by pattern: a regex would also match a future
 * invention that happened to mention "retry signal", and the point of the assertion is
 * that this exact copy is what the user reads.
 */
const ALREADY_RUNNING_SENTENCE = "Another ingest is running. That is a retry signal, not a failure.";

describe("useIngest: a 409 that is not a job-control refusal keeps its own sentence", () => {
  it("reports `start` hitting the lock with the original sentence, not the host's words", async () => {
    // The host's own answer for the mutation lock, as the server suite records it
    // (`{error: {code: "busy", message: …}}`): a code, but not a job-control one.
    const h = controlHarness(({ method, url }) =>
      method === "POST" && url.endsWith("/ingest/jobs")
        ? json({ error: { code: "busy", message: "another mutation holds the lock" } }, 409)
        : undefined,
    );
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));

    await act(async () => {
      await view.result.current.start("https://example.com/a");
    });

    // Byte for byte the copy from before the operator controls existed.
    expect(view.result.current.pollNotice).toEqual({
      kind: "error",
      message: ALREADY_RUNNING_SENTENCE,
    });
  });

  it("reports a 409 with no code at all the same way", async () => {
    // Nothing to classify: a 409 whose body names no code is still the lock, and the
    // sentence must not depend on the host happening to send one.
    const h = controlHarness(({ method, url }) =>
      method === "POST" && url.endsWith("/ingest/jobs") ? new Response(null, { status: 409 }) : undefined,
    );
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));

    await act(async () => {
      await view.result.current.start("https://example.com/a");
    });

    expect(view.result.current.pollNotice).toEqual({
      kind: "error",
      message: ALREADY_RUNNING_SENTENCE,
    });
  });

  it("leaves the document reads saying exactly what they said for a 409", async () => {
    // The documents paths share `noticeFor` and are untouched by the operator controls,
    // so what they render for a 409 has to be the same sentence it was before.
    const h = controlHarness(({ url }) =>
      url.endsWith("/documents") ? json({ error: "conflict" }, 409) : undefined,
    );
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));

    await waitFor(() => expect(view.result.current.documentsNotice).toEqual({
      kind: "error",
      message: ALREADY_RUNNING_SENTENCE,
    }));
  });
});

/**
 * THE FOLLOW MUST SURVIVE A BLIP — AND MUST NOT SURVIVE IT FOREVER
 *
 * The defect: a `fetch` that threw (the `catch` around the read in `ingest.ts`) and any
 * status other than `503`/`404` both `return`ed out of the loop with `reason: "error"`.
 * One blip therefore froze the panel while the job kept running on the server, and the
 * only recovery was a reload.
 *
 * The fix has to be bounded or "keep trying" becomes an endless spinner against a host
 * that will never answer, so the bound is the window the loop already had
 * (`STALL_AFTER_MS`) rather than a second constant. Both halves are asserted here with an
 * injected `sleep` and an injected `Date.now`: no test waits 90 seconds, and no test reads
 * a wall clock to decide whether the loop is bounded.
 *
 * `404` after a snapshot and `503` are the regression guards: they are NOT blips, and
 * folding them into the retry would turn "this job expired" into a spinner.
 */

/** A job snapshot the loop can advance through: `updatedAt` is what makes it move. */
function pollSnapshot(updatedAt: string, settled = false): IngestJob {
  return {
    id: "job_1",
    source: "https://example.com/a",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    ingest: { status: settled ? "succeeded" : "running", stage: "committing", attempts: [] },
    compile: settled
      ? { status: "succeeded", progress: null }
      : { status: "queued", progress: null },
  };
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("pollJob: a transient read failure is retried, not fatal (S2)", () => {
  it("keeps the last snapshot and continues after a network error", async () => {
    const seen: string[] = [];
    const failures: string[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return reply(pollSnapshot("t1"));
      if (calls === 2 || calls === 3) throw new TypeError("Failed to fetch");
      return reply(pollSnapshot("t2", true));
    }) as unknown as typeof fetch;

    const outcome = await pollJob("job_1", {
      headers: () => ({}),
      fetchImpl,
      sleep: async () => {},
      onUpdate: (job) => seen.push(job.updatedAt),
      onTransient: (failure) => failures.push(failure.message),
    });

    // The follow did not end at the first failure: the snapshots arrive in order, and
    // the loop stops only because the job settled.
    expect(seen).toEqual(["t1", "t2"]);
    expect(failures).toEqual(["Failed to fetch", "Failed to fetch"]);
    expect(calls).toBe(4);
    expect(outcome.reason).toBe("settled");
    expect(outcome.job?.updatedAt).toBe("t2");
  });

  it("retries a status that is neither 404 nor 503, and says what it said", async () => {
    let calls = 0;
    const failures: { message: string; status?: number }[] = [];
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return reply({ error: { code: "upstream", message: "no" } }, 502);
      return reply(pollSnapshot("t2", true));
    }) as unknown as typeof fetch;

    const outcome = await pollJob("job_1", {
      headers: () => ({}),
      fetchImpl,
      sleep: async () => {},
      onUpdate: () => {},
      onTransient: (failure) => failures.push(failure),
    });

    // The status travels with the failure, and the sentence is the one this loop has
    // always produced for a bare status — no new copy for a case that has words.
    expect(failures).toEqual([{ status: 502, message: "The server answered 502." }]);
    expect(calls).toBe(2);
    expect(outcome.reason).toBe("settled");
  });

  it("stops with `error` naming the wait once no read succeeds for the stall window (S3)", async () => {
    // The clock is driven, not slept: `Date.now` is the loop's own measure of how long it
    // has gone unanswered, and the injected `sleep` advances it by exactly the delay the
    // backoff asked for.
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    try {
      const outcome = await pollJob("job_1", {
        headers: () => ({}),
        fetchImpl,
        // The whole curve at the ceiling, so the elapsed time is arithmetic rather than an
        // artefact of how the backoff happened to accumulate.
        initialDelay: POLL_MAX_MS,
        sleep: async (ms) => {
          now += ms;
        },
        onUpdate: () => {},
      });

      expect(outcome.reason).toBe("error");
      // The bound is the stall window this loop already had, and the notice names it: 45
      // waits of 2 s, and the 46th read is the one that ends the follow.
      expect(outcome.message).toContain("No read of this job has succeeded for 1 min 30 s");
      expect(calls).toBe(46);
      expect(now).toBe(90_000);
      // Nothing was invented on the way out: no snapshot was ever read, so none is shown.
      expect(outcome.job).toBeUndefined();

      // And it lands on the existing notice channel, not on a new one (S9).
      expect(noticeForOutcome(outcome)).toEqual({ kind: "error", message: outcome.message });
    } finally {
      clock.mockRestore();
    }
  });
});

describe("pollJob: the two answers that are NOT blips keep their meaning (S4)", () => {
  it("ends as `unknown` when a 404 arrives after a snapshot exists", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return reply(pollSnapshot("t1"));
      return reply({ error: { code: "job_not_found" } }, 404);
    }) as unknown as typeof fetch;

    const outcome = await pollJob("job_1", {
      headers: () => ({}),
      fetchImpl,
      sleep: async () => {},
      onUpdate: () => {},
    });

    // A snapshot that arrived and then vanished is EXPIRED, not late: the leading-404
    // tolerance is only for a job nothing has been seen of yet.
    expect(outcome.reason).toBe("unknown");
    expect(calls).toBe(2);
    expect(outcome.job?.updatedAt).toBe("t1");
  });

  it("ends as `unavailable` on a 503, even after a snapshot", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return reply(pollSnapshot("t1"));
      return reply({ error: { code: "jobs_unavailable" } }, 503);
    }) as unknown as typeof fetch;

    const outcome = await pollJob("job_1", {
      headers: () => ({}),
      fetchImpl,
      sleep: async () => {},
      onUpdate: () => {},
    });

    expect(outcome.reason).toBe("unavailable");
    expect(calls).toBe(2);
  });
});

describe("useIngest: a blip reads as reconnecting, not as a failed job (S2)", () => {
  it("keeps the last snapshot on screen, says it is reconnecting, and clears itself", async () => {
    let polls = 0;
    const fetchImpl = (async (url: string) => {
      const href = String(url);
      if (href.includes("/ingest/jobs/")) {
        polls += 1;
        if (polls === 1) return reply(pollSnapshot("t1"));
        if (polls === 2 || polls === 3) throw new TypeError("Failed to fetch");
        // Still moving, so the follow continues on its own and the notice has to be able
        // to disappear without the user doing anything.
        return reply(pollSnapshot(`t${polls}`));
      }
      if (href.endsWith("/documents")) return reply({ documents: [] });
      if (href.endsWith("/stacks")) return reply({ stackIds: ["A"] });
      return reply({ jobs: [] });
    }) as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: "/api",
      headers: () => ({ "x-user-id": "u" }),
      fetchImpl,
    });

    const view = renderHook(() => useIngest({ client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));

    act(() => view.result.current.follow("job_1"));
    await waitFor(() => expect(view.result.current.activeJob?.updatedAt).toBe("t1"));

    await waitFor(() => expect(view.result.current.pollNotice?.kind).toBe("reconnecting"));
    // A blip is not a reason to blank the pane or to claim the job failed: the last
    // snapshot stays, and the loop is still running.
    expect(view.result.current.activeJob?.updatedAt).toBe("t1");
    expect(view.result.current.following).toBe(true);

    // The next good read continues the sequence and clears the notice by itself.
    await waitFor(
      () => expect(view.result.current.activeJob?.updatedAt).toBe("t4"),
      { timeout: 5_000 },
    );
    expect(view.result.current.pollNotice).toBeNull();
    expect(view.result.current.following).toBe(true);

    view.result.current.stopFollowing();
    await waitFor(() => expect(view.result.current.following).toBe(false));
  });
});

/**
 * THE LIST REFRESHES ON ITS OWN, WHILE THE PANEL IS ON SCREEN
 *
 * The defect: `refreshList` was wired to mount and to the actions, and `web/src` had no
 * `setInterval` at all. A job that appeared in Recent stayed absent, and a row that
 * finished stayed "live", until somebody clicked Refresh — the list was a photograph.
 *
 * Three properties are asserted, and the third is the one that keeps the fix from becoming
 * a request storm: an interval while the panel is open, never a second read stacked on one
 * still in flight, and nothing at all when the surface has no Stack.
 *
 * The interval is injected (20 ms) because the real one is 5 s: the value is a product
 * choice, not something a test should wait for.
 */
const TEST_REFRESH_MS = 20;

function intervalHarness() {
  const state = {
    listReads: 0,
    /** Reads at or after this ordinal hang until the test releases them. */
    hangFrom: Number.POSITIVE_INFINITY,
    releases: [] as (() => void)[],
  };
  const fetchImpl = (async (url: string) => {
    const href = String(url);
    if (href.endsWith("/stacks")) return json({ stackIds: ["A"] });
    if (href.endsWith("/documents")) return json({ documents: [] });
    if (!/\/ingest\/jobs(\?|$)/.test(href)) return json({ jobs: [] });
    state.listReads += 1;
    if (state.listReads >= state.hangFrom) {
      await new Promise<void>((resolve) => state.releases.push(resolve));
    }
    return json({ jobs: [] });
  }) as unknown as typeof fetch;
  const client = new ApiClient({
    baseUrl: "/api",
    headers: () => ({ "x-user-id": "u" }),
    fetchImpl,
  });
  return { client, state };
}

describe("useIngest: the jobs list refreshes on an interval (S5)", () => {
  it("refreshes while the panel is open, and stops when it closes", async () => {
    const { client, state } = intervalHarness();
    const view = renderHook(() =>
      useIngest({ client, stackId: "A", listRefreshMs: TEST_REFRESH_MS }),
    );
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));
    const afterMount = state.listReads;

    act(() => view.result.current.setListLive(true));
    await waitFor(() => expect(state.listReads).toBeGreaterThan(afterMount), { timeout: 2_000 });

    // And it stops when the panel closes: a timer over a list nobody is looking at is the
    // same request storm in a quieter place.
    act(() => view.result.current.setListLive(false));
    const afterClose = state.listReads;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(state.listReads).toBe(afterClose);
  });

  it("does not stack a refresh on one that is still in flight", async () => {
    const { client, state } = intervalHarness();
    const view = renderHook(() =>
      useIngest({ client, stackId: "A", listRefreshMs: TEST_REFRESH_MS }),
    );
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));

    // Every read from the next one on hangs until the test says otherwise, so several
    // interval ticks land while the first is genuinely outstanding.
    state.hangFrom = state.listReads + 1;
    act(() => view.result.current.setListLive(true));
    await waitFor(() => expect(state.listReads).toBe(2), { timeout: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(state.listReads).toBe(2);
    expect(state.releases).toHaveLength(1);

    // Once it answers, the interval carries on: the guard defers a read, it does not stop
    // the refresh.
    await act(async () => {
      for (const release of state.releases) release();
    });
    await waitFor(() => expect(state.listReads).toBeGreaterThan(2), { timeout: 2_000 });
    act(() => view.result.current.setListLive(false));
  });

  it("issues no request at all when the surface has no Stack", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return json({ stackIds: [] });
    }) as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: "/api",
      headers: () => ({ "x-user-id": "u" }),
      fetchImpl,
    });

    const view = renderHook(() =>
      useIngest({ client, stackId: null, listRefreshMs: TEST_REFRESH_MS }),
    );
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));
    act(() => view.result.current.setListLive(true));
    await new Promise((resolve) => setTimeout(resolve, 120));

    // `GET /stacks` is the only thing this state may ask, exactly as before: no list read,
    // no poll, nothing into a tenant nobody named.
    expect(seen.filter((url) => !url.endsWith("/stacks"))).toEqual([]);
  });
});

/**
 * COMING BACK TO THE PAGE MUST NOT MEAN PRESSING F5
 *
 * The third gap in the report: `follow` was only ever called from a user action, so a
 * reload lost the follow and the panel opened on an empty detail pane while the job ran on.
 * The decision (Option A, `odd/tasks/ingest-follow-resilience.md` L3) is automatic and has
 * no link parameter: on the first list read of a visit, with nothing being followed, adopt
 * the most recently updated job that still has work ahead of it.
 *
 * The second half of that rule is what these tests are really about: the automation gets ONE
 * chance per visit. Once the user picks a job, stops a follow, or the adopted job ends, the
 * screen belongs to the user and nothing is imposed again.
 */
function listJob(
  id: string,
  updatedAt: string,
  status: "running" | "succeeded" = "running",
): IngestJob {
  return {
    id,
    source: "https://example.com/a",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    ingest: { status, stage: "committing", attempts: [] },
    compile:
      status === "running"
        ? { status: "queued", progress: null }
        : { status: "succeeded", progress: null },
  };
}

/** The list, mutable between reads; a poll answers the job it names, else a settled one. */
function autoResumeHarness(initial: IngestJob[]) {
  let jobs = initial;
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const href = String(url);
    calls.push({ method: init?.method ?? "GET", url: href });
    if (href.includes("/ingest/jobs/")) {
      const id = decodeURIComponent(href.split("/ingest/jobs/")[1]!.split("?")[0]!);
      return json(jobs.find((job) => job.id === id) ?? listJob(id, "2026-01-01T00:00:09.000Z", "succeeded"));
    }
    if (href.endsWith("/stacks")) return json({ stackIds: ["A"] });
    if (href.endsWith("/documents")) return json({ documents: [] });
    return json({ jobs });
  }) as unknown as typeof fetch;
  const client = new ApiClient({
    baseUrl: "/api",
    headers: () => ({ "x-user-id": "u" }),
    fetchImpl,
  });
  return {
    client,
    setJobs: (next: IngestJob[]) => {
      jobs = next;
    },
    polls: () => calls.filter((call) => call.url.includes("/ingest/jobs/")),
  };
}

describe("useIngest: it re-attaches to a running job on mount (S6)", () => {
  it("follows the only running job without the user asking", async () => {
    const h = autoResumeHarness([listJob("job_run", "2026-01-01T00:00:05.000Z")]);
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));

    await waitFor(() => expect(view.result.current.activeId).toBe("job_run"));
    expect(view.result.current.following).toBe(true);
    expect(h.polls().some((call) => call.url.includes("/ingest/jobs/job_run"))).toBe(true);

    view.result.current.stopFollowing();
    await waitFor(() => expect(view.result.current.following).toBe(false));
  });

  it("follows the most recently updated one when several are still running", async () => {
    const h = autoResumeHarness([
      listJob("job_older", "2026-01-01T00:00:01.000Z"),
      listJob("job_newest", "2026-01-01T00:00:09.000Z"),
      listJob("job_middle", "2026-01-01T00:00:04.000Z"),
    ]);
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));

    await waitFor(() => expect(view.result.current.activeId).toBe("job_newest"));
    expect(h.polls().some((call) => call.url.includes("/ingest/jobs/job_older"))).toBe(false);

    view.result.current.stopFollowing();
    await waitFor(() => expect(view.result.current.following).toBe(false));
  });

  it("follows nothing when every job has finished or is blocked", async () => {
    // Two different kinds of dead: a settled job, and a job whose ingest FAILED while its
    // compile still reads `queued` — nothing will ever start that compile, so adopting it
    // would open the panel on a corpse.
    const blocked = listJob("job_blocked", "2026-01-01T00:00:08.000Z");
    blocked.ingest = { status: "failed", stage: "committing", attempts: [], error: "boom" };
    const h = autoResumeHarness([
      listJob("job_done", "2026-01-01T00:00:05.000Z", "succeeded"),
      blocked,
    ]);
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));

    await waitFor(() => expect(view.result.current.loadingList).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(view.result.current.activeId).toBeNull();
    expect(h.polls()).toEqual([]);
  });
});

describe("useIngest: the automation never overrides the user (S7)", () => {
  it("does not take the screen back once the user follows another job", async () => {
    const h = autoResumeHarness([listJob("job_run", "2026-01-01T00:00:05.000Z")]);
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.activeId).toBe("job_run"));

    // The user picks one instead, and it is already finished.
    act(() => view.result.current.follow("job_done"));
    await waitFor(() => expect(view.result.current.activeId).toBe("job_done"));
    await waitFor(() => expect(view.result.current.following).toBe(false));

    // A later read of the list surfaces something newer and still running.
    h.setJobs([
      listJob("job_run", "2026-01-01T00:00:05.000Z"),
      listJob("job_newer", "2026-01-01T00:00:09.000Z"),
    ]);
    await act(async () => {
      await view.result.current.refreshList();
    });

    expect(view.result.current.activeId).toBe("job_done");
    expect(h.polls().some((call) => call.url.includes("job_newer"))).toBe(false);
  });

  it("does not start anything again after the user stops following", async () => {
    const h = autoResumeHarness([listJob("job_run", "2026-01-01T00:00:05.000Z")]);
    const view = renderHook(() => useIngest({ client: h.client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.activeId).toBe("job_run"));

    view.result.current.stopFollowing();
    await waitFor(() => expect(view.result.current.following).toBe(false));

    h.setJobs([
      listJob("job_run", "2026-01-01T00:00:05.000Z"),
      listJob("job_other", "2026-01-01T00:00:07.000Z"),
    ]);
    await act(async () => {
      await view.result.current.refreshList();
    });

    expect(view.result.current.following).toBe(false);
    expect(h.polls().some((call) => call.url.includes("job_other"))).toBe(false);
  });
});
