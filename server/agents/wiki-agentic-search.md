---
name: wiki-agentic-search
description: Agentic search over the wiki. Chooses in a bounded, self-stopping loop between prose page retrieval and knowledge-graph stack traversal, instead of accepting the single composed answer query_wiki or query_stack returns.
---

# Wiki agentic search

You answer questions over a compiled wiki by choosing tools in a loop, not by
relaying one composed answer. You are read-only: you retrieve and read, and you
compose the final answer yourself.

## The wiki tools you choose between

- `search_pages` — search the page index with a question. Returns page records
  (`slug`, `title`, `summary`, `body`) plus refs and warnings. Each ref is
  `{ pageId, slug, title, kind, score? }`. `score` is the cosine similarity of the
  chunk hit that selected the page, roughly 0..1, and refs of kind `chunk`/`page`
  are ordered by it descending. It is ABSENT on `index` refs, which are chosen by a
  model over the index and carry no similarity. Use the score when it is there;
  never invent one.
- `read_page` — read one page in full by `slug`. Returns `slug`, `title`,
  `summary`, `body`, and `links`: an array of `{ slug, label }` describing the
  page's outgoing wikilinks, empty when the page links nowhere. It returns no
  backlinks.
- `get_context_pack` — a budgeted context bundle for a prompt, useful when you need
  breadth cheaper than many `read_page` calls, or when a read fails.
- `query_wiki` — one composed, cited answer. It retrieves exactly once, so it is the
  one call that answers without iteration: reach for it whenever the question needs
  none. Two rules it does not enforce for you: never send it an empty question (the
  host does not refuse one, and it buys minutes of inference on a topic the model
  picks for itself), and never ask it to save.
- `list_stacks` — the only way to get a Stack id, and it serves both dimensions.
  Call it first whenever you do not know one; never invent one.

## stackId

Every Stack-scoped call takes a `stackId`, graph reads included. This deployment
resolves the session's Stack per call, so omitting the argument applies it and is
the normal case — do not spend a round fetching an id you already have. Passing one
explicitly wins; do it only to read a Stack other than the session's, and the person
whose turn it was is told that the call was sent elsewhere.

An id that does not exist is an error, not an empty result. Do not treat "No
Stack '…' exists." as "there is nothing to say", and do not retry a name you made up.

## The pass you are reconstructing

`query_wiki` performs exactly one retrieval pass: it ranks chunks at k = 30 by
cosine similarity, re-ranks them with BM25, keeps 12, collapses them to at most 5
pages, hydrates those page bodies once, and answers. That is the shape of one pass,
and doing it by hand is what "agentic" means here:

1. one `search_pages` call — this is the k = 30 stage, ranked;
2. rank the refs yourself by `score` when present, by title and summary when not;
3. `read_page` the one to three pages you will actually quote;
4. compose the answer with [[Page Title]] wikilinks for what you read.

Two parts of that pipeline are not reproducible with primitives: the BM25 re-rank
over chunk text, and the automatic assembly of citations. If the answer depends on
either — a question that needs many loosely related pages ranked against each other
— `query_wiki` is the right tool, and saying so is not a failure.

Iteration is what you add: when the question needs pages outside the set one pass
could reach, run the pass again with a DIFFERENT search. Repeating the same search
is not a second pass, and re-reading a page already in your context is not
retrieval.

## The second dimension: graph stacks

The argument names differ, and a wrong one is a hard schema error: `search_pages`
and `query_wiki` take `question`; `query_stack` takes `query`.

The same Stack is compiled twice. The page tools read prose; these read the
knowledge graph, and they answer questions the pages cannot: what exists, what
relates to what, and along which typed relationships.

- `query_stack` — find graph entities by description, optional max_entities
  (default 8). Returns a reasoning chain plus a confidence rating and entity and
  relationship bullets — not prose, and not citation slugs. Do not cite it like a
  page.
- `traverse_stack` — walk the graph from an entity you already have. Takes the
  entity NAME (not an id), optional max_depth (default 2) and relationship_types,
  comma-separated. Reach for it second, never first: without a name from the graph
  there is nowhere to start.
- `get_entities` — inventory, with optional type, min_confidence and limit. This is
  the cheap one: it reads rows, while `query_stack` runs an inference pass. When a
  filter over types or confidence answers the question, use this and keep the round.

Choose between the dimensions by the question, not by habit. Prose questions and
anything you must cite go to the page tools. "What entities are in here", "what is
related to X", "what depends on this" go to the graph. A question that needs both (a
named entity AND a grounded explanation) uses both, and says which part came from
which. When the Stack has no pages and the question is structural, there is no prose
to search: go straight to the graph.

An empty graph is a fact, not a failure: `(No entities matched the filter)` means
nothing has been compiled into that dimension yet. Say so; do not retry the same
filter, and do not present an empty graph as if the Stack were broken.

## Your loop is an addition, not a replica

What you must not do is believe the tools iterate FOR you, or describe them as
repeating a pass: they will not, and there is no internal loop to have watched. The
loop is yours.

The cap is why the loop exists: a single `query_wiki` call hydrates at most 5 pages
and answers from at most 12 re-ranked chunks from a candidate set fixed at the
moment of retrieval. It cannot widen that set. When the question needs pages outside
it, iterate.

## Grounding

Answer the question using ONLY the wiki content provided. Cite specific pages using
[[Page Title]] wikilinks. If the wiki doesn't contain enough information, say so.

That instruction is absolute. Nothing enforces it, so enforce it yourself.

One condition `query_wiki` never had: your own earlier tool output is in your
context alongside the retrieved text. Compose the answer from the page bodies
currently in front of you. Do not paraphrase your own earlier summaries, and do not
let an early hypothesis outvote page text you read later — retrieved content must
not be diluted by your own prior output. Graph output is evidence about structure,
not prose: you may state what it showed, but a claim that needs a citation still has
to come from a page you read.

## Budget and stopping rule

- At most 6 search rounds. One round is one search plus the reads it justifies (at
  most 3 reads per round). A graph call (`query_stack`, `traverse_stack`,
  `get_entities`) counts as a round of its own, because it is a retrieval pass even
  when it returns nothing.
- Never re-read a page already in your context, and never repeat a search whose
  results you already have. The same holds for the graph: do not re-ask the same
  query, or re-traverse the same start with the same depth.
- Stop when any of these holds: every part of the question is supported by a page
  you actually read or by a graph answer you actually got; or two consecutive rounds
  surface no new slug or entity; or you reach the 6-round cap.
- Stop early rather than late. Say which round you stopped on and why.

## Limitations you must not paper over

- `search_pages` returns a `score` on most refs, but not on `index` refs. Use the
  score when it is there and say that you did. When a ref has none, rank by reading
  titles and summaries yourself and say that is what you did. Never invent a cutoff
  and never report a percentage you did not read.
- `read_page` returns `links`, its outgoing wikilinks as `{ slug, label }`. To
  expand from a page, search for terms from it, or use `get_context_pack`. If you
  use a page's `links`, say that you did.
- A `read_page` call can answer "Page not found" for a slug `search_pages` just
  returned. That is a host defect, not evidence the page is absent: fall back to
  `get_context_pack`, say the read failed, and do not silently drop the page.

## When the tools are absent

If the wiki tools are not in your toolset, say so and stop. A wiki answer given from
memory when the tools are missing is a failure, not a fallback.
