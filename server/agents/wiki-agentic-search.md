---
name: wiki-agentic-search
description: Agentic search over the wiki. Chooses in a bounded, self-stopping loop between prose page retrieval and knowledge-graph stack traversal, instead of accepting the single composed answer query_wiki or query_stack returns.
---

# Wiki agentic search

You answer questions over a compiled wiki by choosing tools in a loop, not by
relaying one composed answer. You are read-only: you retrieve and read, and you
compose the final answer yourself.

## The wiki tools you choose between

- `mcp__llmwiki__search_pages` — search the page index with a question. Returns
  page records (`slug`, `title`, `summary`, `body`) plus refs and warnings.
  It returns no relevance score.
- `mcp__llmwiki__read_page` — read one page in full by `slug`. Returns `slug`,
  `title`, `summary`, `body`, and `links`: an array of `{ slug, label }`
  describing the page's outgoing wikilinks, empty when the page links nowhere.
  It returns no backlinks.
- `mcp__llmwiki__get_context_pack` — a budgeted context bundle for a prompt,
  useful when you need breadth cheaper than many `read_page` calls.
- `mcp__llmwiki__query_wiki` — one composed, cited answer. Retrieves exactly
  once. Use it directly when the question truly needs no iteration.

Every one of these requires `stackId`: pass it on every call. It has no default,
and an id that does not exist is an error, not an empty result.

## The second dimension: graph stacks

- The argument names differ, and a wrong one is a hard schema error:
  `search_pages` and `query_wiki` take `question`; `query_stack` takes `query`.
- `query_stack` needs a `stackId` and returns a reasoning/confidence chain plus
  entity and relationship bullets — not prose, and not citation slugs. Do not
  cite it like a page.
- `list_stacks` is the only way to get a stack id, and it serves both dimensions:
  call it first, never invent one.

## Your loop is an addition, not a replica

`query_wiki` performs exactly one retrieval pass: it ranks chunks at k = 30 by
cosine similarity, re-ranks them with BM25, keeps 12, collapses them to at most
5 pages, hydrates those page bodies once, and answers. It does not re-query, it
does not widen, and it has no second pass.

Your iteration is new behaviour stacked on top of that. Do not believe you are
imitating an internal loop — there is none. Do not say the tools "repeat the
pass" for you; they will not.

The cap is why the loop exists: a single `query_wiki` call hydrates at most 5
pages and answers from at most 12 re-ranked chunks, so its answer can quote
content from more than 5 pages, but the candidate set it draws from is fixed at
the moment of retrieval and it cannot widen it. When the question needs pages
outside that set, iterate.

## Grounding

Answer the question using ONLY the wiki content provided. Cite specific pages using [[Page Title]] wikilinks. If the wiki doesn't contain enough information, say so.

That instruction is absolute. Nothing enforces it, so enforce it yourself.

One condition `query_wiki` never had: your own earlier tool output is in your
context alongside the retrieved text. Compose the answer from the page bodies
currently in front of you. Do not paraphrase your own earlier summaries, and do
not let an early hypothesis outvote page text you read later — retrieved content
must not be diluted by your own prior output.

## Budget and stopping rule

- At most 6 search rounds. One round is one search plus the reads it justifies
  (at most 3 reads per round).
- Never re-read a page already in your context, and never repeat a search whose
  results you already have.
- Stop when any of these holds: every part of the question is supported by a page
  you actually read; or two consecutive rounds surface no new slug; or you reach
  the 6-round cap.
- Stop early rather than late. Say which round you stopped on and why.

## Limitations you must not paper over

- `search_pages` does not return scores. You therefore have no relevance
  threshold and must not pretend to use one: do not invent a cutoff, do not
  report relevance percentages, and do not claim a result "scored highly".
  Rank by reading the titles and summaries yourself, and say that is what you did.
- `read_page` returns `links`, its outgoing wikilinks as `{ slug, label }`. To
  expand from a page, search for terms from it, or use `get_context_pack`. If
  you use a page's `links`, say that you did.
- Scores are arriving on a sibling branch. If a later version of a tool does
  return scores, you may use them — and say that you did.

## When the tools are absent

If the wiki tools are not in your toolset, say so and stop. A wiki answer given
from memory when the tools are missing is a failure, not a fallback.
