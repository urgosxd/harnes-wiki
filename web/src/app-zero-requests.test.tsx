import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.tsx";

/**
 * The ingest surface makes NO tenant-scoped request when the link names no Stack, and
 * every request when it does — measured at the App boundary rather than inside the hook.
 * The one exception in the blocked state is the unscoped `GET /stacks`, which exists to
 * offer the choice (S3/S4) and therefore cannot require one.
 *
 * The hook-level tests prove the early returns; this proves what actually leaves the
 * browser, including the one failure mode a hook test cannot see: a request issued by
 * something other than the path under test. A read with no Stack is not an empty list,
 * it is a read of whichever tenant the endpoint happens to be bound to.
 *
 * Adapted from the independent verification pass (claim 10), which drove the same
 * shapes against a scratch copy.
 */
function useUrl(search: string) {
  window.history.replaceState(null, "", `/${search}`);
}

interface Seen {
  url: string;
  headers: Record<string, string>;
}

/** Answers the chat endpoints so the product renders, and records everything fetched. */
function stubApi(): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
      if (url.includes("/me")) return new Response(JSON.stringify({ id: "alice", displayName: "alice" }));
      if (url.includes("/conversations")) return new Response(JSON.stringify({ conversations: [] }));
      if (url.includes("/documents")) return new Response(JSON.stringify({ documents: [] }));
      if (url.includes("/ingest/jobs")) return new Response(JSON.stringify({ jobs: [] }));
      return new Response(JSON.stringify({}));
    }),
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ingestCalls = (seen: readonly Seen[]) => seen.filter((call) => call.url.includes("/ingest"));

/**
 * Every request a Stack scopes: the job list read, a poll, a create, and the document
 * routes. `/stacks` is deliberately NOT in here — it is the unscoped list of choices,
 * which is why it may be requested while nothing else can be.
 */
const tenantScopedCalls = (seen: readonly Seen[]) =>
  seen.filter((call) => call.url.includes("/ingest") || call.url.includes("/documents"));

describe("ingest scoping at the App boundary", () => {
  for (const [label, search] of [
    ["absent", "?user=alice"],
    ["empty", "?user=alice&stackId="],
    ["whitespace", "?user=alice&stackId=%20%20"],
    ["a Stack with no user", "?stackId=s-1"],
  ] as const) {
    it(`blocks the surface and fetches nothing when stackId is ${label}`, async () => {
      useUrl(search);
      const seen = stubApi();
      render(<App />);

      const hasUser = search.includes("user=");
      if (hasUser) {
        await waitFor(() => expect(screen.getByText("Ingest jobs")).toBeDefined());
        fireEvent.click(screen.getByText("Ingest jobs"));
      }
      // Long enough for a request to have been fired and recorded.
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(ingestCalls(seen)).toHaveLength(0);
      if (hasUser) {
        expect(screen.getByRole("alert").textContent).toContain("needs a stackId in the link");
        expect(screen.queryByText("Start ingest")).toBeNull();
        expect(screen.queryByLabelText("Choose a document")).toBeNull();
        // Chat is not the thing being blocked: it is one click away, still empty of ingest.
        fireEvent.click(screen.getByText("Back to chat"));
        expect(screen.queryAllByRole("textbox").length).toBeGreaterThan(0);
        expect(ingestCalls(seen)).toHaveLength(0);
        // Nothing tenant-scoped was requested in this state, before or after the switch:
        // no job list read, no poll, no create, no document route. A read with no Stack
        // is not an empty list, it is a read of whichever tenant the endpoint is bound
        // to, so zero is the only acceptable count. The unscoped `GET /stacks` is allowed
        // and expected: it is the list of choices S4 tells the user to pick from, so it
        // cannot itself depend on already knowing a Stack.
        expect(tenantScopedCalls(seen)).toHaveLength(0);
        expect(seen.some((call) => call.url.endsWith("/stacks"))).toBe(true);
      }
      // And no Stack header invented for a link that named none.
      expect(seen.every((call) => call.headers["x-stack-id"] === undefined)).toBe(true);
    });
  }

  it("lists jobs for the link's Stack and forwards it as a header", async () => {
    useUrl("?user=alice&stackId=s-1");
    const seen = stubApi();
    render(<App />);

    await waitFor(() => expect(screen.getByText("Ingest jobs")).toBeDefined());
    fireEvent.click(screen.getByText("Ingest jobs"));
    await waitFor(() => expect(ingestCalls(seen).length).toBeGreaterThan(0));

    expect(ingestCalls(seen)[0]?.url).toContain("stackId=s-1");
    // The link's Stack is what this surface uses, and the control shows it as the
    // selected value: S3 adds the ability to ingest into another one, so the picker
    // exists and its preselected Stack is still the link's.
    expect((screen.getByLabelText("Stack") as HTMLSelectElement).value).toBe("s-1");
    // Every request carries the tenant, including the chat endpoints: the server needs it
    // on the turn, and this product does not vary the header per route.
    expect(seen.every((call) => call.headers["x-stack-id"] === "s-1")).toBe(true);
  });
});
