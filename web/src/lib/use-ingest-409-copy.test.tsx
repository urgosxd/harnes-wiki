import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ApiClient, ApiError } from "./api.ts";
import { noticeFor, useIngest } from "./use-ingest.ts";

/**
 * WHY THESE ASSERTIONS
 *
 * `noticeFor` is ONE mapping shared by every ingest call, and since the operator
 * controls landed it answers two unrelated questions on the same status code:
 *
 *   - `job_still_working` / `job_changed` are the host's answer ABOUT ONE JOB, so the
 *     host's own code and words reach the screen;
 *   - anything else on a `409` — the `busy` concurrency lock, or a body naming no code
 *     at all — is a RETRY SIGNAL, and keeps byte for byte the sentence this surface has
 *     shown since before the controls existed.
 *
 * That split is decided by an ALLOW-LIST, and an allow-list is only as good as its
 * edges. A code that is merely similar (`job_still_working` with a trailing space), the
 * same code in the wrong case (`BUSY`), a neighbouring fact (`turn_in_progress`), a
 * generic `conflict`, or an empty string must all FALL THROUGH to the original
 * sentence instead of being read as a job-control refusal. The `busy` code and the
 * code-less `409` are already pinned in the sibling `use-ingest.test.tsx`, as is the
 * document-list consumer of this branch; what is pinned HERE is the rest of the
 * boundary and the other consumer that was not: the job list.
 *
 * Every copy assertion is literal equality on the whole sentence. A regex would also
 * match a future invention that merely mentioned "retry signal", and a `toContain`
 * would pass on a message that had grown a prefix.
 */

/** The concurrency-lock sentence, exactly as long as it has been shown. */
const ALREADY_RUNNING_SENTENCE = "Another ingest is running. That is a retry signal, not a failure.";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A real `ApiClient` over a stubbed transport.
 *
 * The `409` under test is then one the client actually built from a response, instead
 * of an object a mock handed to the hook.
 */
function harness(answer: (call: { method: string; url: string }) => Response | undefined): ApiClient {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const href = String(url);
    const custom = answer({ method: init?.method ?? "GET", url: href });
    if (custom) return custom;
    if (href.endsWith("/stacks")) return json({ stackIds: ["A"] }, 200);
    if (href.endsWith("/documents")) return json({ documents: [] }, 200);
    return json({ jobs: [] }, 200);
  }) as unknown as typeof fetch;

  return new ApiClient({
    baseUrl: "/api",
    headers: () => ({ "x-user-id": "u" }),
    fetchImpl,
  });
}

/**
 * The codes the job-control allow-list does NOT name.
 *
 * Each is a `409` whose code says nothing about one job, so each keeps the lock's
 * sentence. They are spelled out rather than derived: the point is the exact strings a
 * classifier must reject, including the near miss.
 */
describe("use-ingest: a 409 code outside the job-control allow-list keeps the lock sentence", () => {
  const OUTSIDE_THE_ALLOW_LIST = [
    // Another producer's vocabulary for "something else is busy".
    "turn_in_progress",
    // Generic, and the code the document paths already carry unchanged.
    "conflict",
    // The lock's own code in the wrong case: codes are compared exactly.
    "BUSY",
    // The right code with a trailing space — a different string, so not the same fact.
    "job_still_working ",
    // Present but empty: a code that names nothing classifies nothing.
    "",
  ];

  for (const code of OUTSIDE_THE_ALLOW_LIST) {
    it(`reports the code ${JSON.stringify(code)} with the original sentence`, () => {
      expect(noticeFor(new ApiError(409, code, "host said something"))).toEqual({
        kind: "error",
        message: ALREADY_RUNNING_SENTENCE,
      });
    });
  }

  it("keeps it on the job list, the other consumer of the same branch", async () => {
    // `refreshList` maps its failure through the SAME `noticeFor`. A `409` there is the
    // lock too: the list could not be read because another mutation holds it, and that
    // is a retry signal, not a failed read.
    const client = harness(({ method, url }) =>
      method === "GET" && /\/ingest\/jobs(\?|$)/.test(url)
        ? json({ error: { code: "conflict", message: "another mutation holds the lock" } }, 409)
        : undefined,
    );
    const view = renderHook(() => useIngest({ client, stackId: "A" }));
    await waitFor(() => expect(view.result.current.loadingList).toBe(false));

    await act(async () => {
      await view.result.current.refreshList();
    });

    expect(view.result.current.listNotice).toEqual({
      kind: "error",
      message: ALREADY_RUNNING_SENTENCE,
    });
  });
});

describe("use-ingest: the two allow-listed codes are the host's answer, not the lock", () => {
  it("states `job_still_working` as the refusal it is", () => {
    // A body that names the code and says nothing else usable: the CODE is the answer,
    // so it is the subject of the sentence rather than the generic status text, and the
    // lock's "retry signal" sentence must not appear.
    expect(noticeFor(new ApiError(409, "job_still_working", "request failed with 409"))).toEqual({
      kind: "error",
      message: "The host refused this request: job_still_working.",
    });
  });

  it("carries the host's own words for `job_changed`, prefixed by its code", () => {
    // The host did say something, so its sentence reaches the screen with the code in
    // front of it: the operator has to tell a job that MOVED from one that is WORKING.
    expect(noticeFor(new ApiError(409, "job_changed", "the job moved under this request"))).toEqual({
      kind: "error",
      message: "job_changed: the job moved under this request",
    });
  });
});
