import { describe, it, expect } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ApiClient } from "./api.ts";
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
