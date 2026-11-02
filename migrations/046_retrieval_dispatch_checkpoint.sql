-- STA-45: the retrieval worker's claims take space/collection pairs with
-- pending work in turn, as a ring, from the pair after the last one a claim
-- served, across steps and workers. One sustained backlog therefore cannot
-- keep another pair's work from being served within a bounded number of
-- claims. Like outbox_dispatch_checkpoint, this one cell-local row holds
-- only a position: it names no content and is never space-scoped data.
CREATE TABLE retrieval_dispatch_checkpoint (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  after_space_id text,
  after_collection_id text,
  CHECK ((after_space_id IS NULL) = (after_collection_id IS NULL))
);
INSERT INTO retrieval_dispatch_checkpoint DEFAULT VALUES;
