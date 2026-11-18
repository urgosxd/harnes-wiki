import { describe, it, expect } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ApiClient } from "./api.ts";
import type { IngestJob } from "./ingest.ts";
import { useIngest } from "./use-ingest.ts";

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
