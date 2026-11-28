-- Which content a document carries, and one ingest state PER STACK.
--
-- ## Why a hash column, and not a boolean
--
-- "Ingested" is not a property anyone can store: it is the answer to a comparison
-- between the file we hold and the source the wiki compiled. A boolean would say
-- yes until the day the file is replaced, and then keep saying yes about bytes the
-- wiki never saw. A hash makes the mark self-invalidating: replace the content and
-- the stored hash stops matching, so the mark disappears without anything having to
-- remember to clear it.
--
-- It is also the only form in which the comparison can be made at all: the wiki
-- publishes a `source_hash` per compiled source, and nothing else about our bytes
-- survives into it.
--
-- ## Why the hash is computed in Node, not here
--
-- `pgcrypto` would make `digest()` available and is deliberately NOT used. The
-- bytes are written by the server, which already has them in hand; hashing there
-- costs no extension to install on every deployment (and no version to keep in
-- step with Postgres), and keeps one implementation of "what the hash is" instead
-- of two that can disagree.
--
-- ## Why NULL is allowed
--
-- Every document uploaded before this migration was never hashed, and inventing a
-- value for them would be a lie of exactly the kind the hash exists to prevent:
-- backfilling by hashing `content` now would claim those documents were marked
-- against the wiki when nothing has checked. NULL means "no mark", which is true.
--
-- ## Why the primary key becomes composite
--
-- The same uploaded file can be ingested into more than one Stack, and each Stack
-- is compiled and can be retracted independently. One row per document would
-- collapse those independent states into one and make retracting from one Stack
-- look like retracting from all of them. So identity is (document, Stack).

-- Refuse BEFORE touching anything, because the composite key cannot be installed
-- over rows that have no `stack_id`: Postgres would either fail on the NOT NULL
-- implied by the key, or - worse, if the column had a default - silently assign
-- every existing row to one arbitrary Stack. There is no correct automatic answer,
-- and there must not be one: `recordIngest` has no callers, so this table is empty
-- in every deployment that ever ran this code, and a row here means someone wrote
-- one by hand and a human has to say which Stack it belongs to.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM document_ingests) THEN
    RAISE EXCEPTION 'document_ingests is not empty: review before changing the primary key';
  END IF;
END $$;

ALTER TABLE documents ADD COLUMN content_hash text;

-- The mark is read per USER: the panel lists one user's documents and asks, for
-- each, whether its hash is one the wiki has compiled. A global index would still
-- answer, but it would grow with every other user's uploads.
CREATE INDEX documents_by_user_hash ON documents (user_id, content_hash);

ALTER TABLE document_ingests ADD COLUMN stack_id text;

ALTER TABLE document_ingests DROP CONSTRAINT document_ingests_pkey;

-- Composite, and the NOT NULL on `stack_id` comes with it. That is the intended
-- outcome: an ingest state that cannot name its Stack cannot be retracted from it.
ALTER TABLE document_ingests ADD PRIMARY KEY (document_id, stack_id);
