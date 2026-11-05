---
name: llm-wiki-mcp
description: Use when calling the llm-wiki MCP host tools (list_stacks, wiki_status, ingest_jobs_list, ingest_job_status, query_wiki, search_pages, read_page, get_context_pack, ingest_source, compile_wiki, export_okf, import_okf, run_eval) or when a Stack selection, paging, error-text or write-safety question comes up for that host.
---

# llm-wiki MCP host

Evidence tags: **Measured** = observed on 2026-11-05 against host build
`6b83fbad88169caf5a6b4e8c173c193465c849c8`; **Hypothesis** = plausible, unverified.
The schemas already say what each tool does; this file covers only what they miss.

## The host is stateless — nothing to hold on to (Measured)

No `Mcp-Session-Id` is issued, a fabricated one is accepted anyway, and `DELETE /mcp`
answers `405`. The Stack is chosen per call through `stackId`, and no state survives
a request, so there is no session-scoped Stack to cache: never carry a remembered
Stack forward as if the connection held it.

## `stackId` is required almost everywhere (Measured)

13 of the 14 tools mark `stackId` required, worded "required, with no default and no
fallback". `list_stacks` is the exception: its schema publishes no `required` array,
and the value it receives only marks an entry `isCurrent`. Pass it from a
Stack-scoped turn; expect no other effect.

## `list_stacks` pages — it never states a total (Measured)

The listing pages at 50 by default, 200 max via `limit`, and the response carries no
`total`, `cursor`, `offset` or `hasMore`, so truncation is undetectable from the
response: 200 entries do not mean 200 Stacks exist. It is a page of an inventory,
not an authority list of "the Stacks you may use" — widen `limit` before any
"only these exist" claim.

## Failures carry no structured code (Measured)

Error responses expose no code field: a missing page, an unknown Stack and a missing
argument are distinguishable only by matching message text, which is fragile by
construction, since reworded text silently reclassifies a failure. Quote the message
when reporting one and never branch durable logic on it.

## `import_okf` can refuse an import nothing can clear (Measured)

It may answer "Review queue would exceed the cap; approve/reject pending candidates
first." No exposed tool approves, rejects, deletes or unstages a candidate, so
retrying cannot succeed: stop and report the refusal and its text, with no workaround.

## Writes need a before/after snapshot (Measured)

No transaction boundary is visible from the tools, so a green write proves only that
nothing threw. Take a `wiki_status` snapshot of the target Stack, write, snapshot
again and compare. Never write to a Stack nobody declared disposable.

## Do not confuse this with the browser surface (Measured)

This product's UI reads the Stack listing over REST `GET /stacks`
(`server/src/ingest/client.ts:118-133` behind `server/src/api/ingest-routes.ts:313`),
not through `list_stacks`. An empty REST listing says nothing about what the tool
would return, and the reverse also holds.

## Unverified, do not repeat as fact (Hypothesis)

`sources` appears to count committed sources, while `pages.concepts` appears to
include pending candidate pages that `sources` does not. If a caller compares them,
say the counts may disagree for that reason instead of asserting which is right.
