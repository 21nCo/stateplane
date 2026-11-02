-- STA-44 (STA-14 slice 1): storage for rebuildable lexical and vector
-- projections. Projections are derived data: authoritative records, sources
-- and claims stay independently readable, and every projection row names the
-- canonical Ref, authoritative revision and generation it was built from, so a
-- result is always reread and reauthorized at authority before it is returned.
--
-- Take the locks this step needs up front. Claim revise and review insert a
-- claim revision before they advance its `entity_refs` row, so
-- `claim_revisions` is locked first; a claim create writes the other way
-- round, and if PostgreSQL resolves that cycle by aborting this step the
-- migrator reports it as a retry, like a lock wait timeout. The new tables
-- are empty; the backfill below reads only evidence tables, while writers to
-- them wait (docs/retrieval-projections.md#upgrade-restore-and-grants).
LOCK TABLE collections, records, claim_revisions, entity_refs, extraction_versions IN SHARE ROW EXCLUSIVE MODE;

-- Rows of these tables are facts: never changed, and removed only by the
-- table owner inside the scoped erasure routine for the space being erased.
CREATE FUNCTION reject_retrieval_fact_change() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = pg_catalog.pg_get_userbyid(
      (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID))
    AND current_setting('stateplane.erasing_space', true) = OLD.space_id THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_immutable';
END;
$$;
REVOKE ALL ON FUNCTION reject_retrieval_fact_change() FROM PUBLIC;

-- Per-collection retrieval policy, as immutable versions starting at 1
-- without gaps; the highest version is current. A policy names the content a
-- projection may index (record fields as JSON Pointers, source extraction
-- content, claim statements), which projections are enabled, the built-in
-- text search configuration, and the regions where embedding may be
-- processed. Lexical projection runs inside the cell's own database.
CREATE TABLE retrieval_policies (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  previous_version bigint GENERATED ALWAYS AS (NULLIF(version - 1, 0)) STORED,
  record_fields text[] NOT NULL DEFAULT '{}' CHECK (cardinality(record_fields) <= 32),
  source_content boolean NOT NULL DEFAULT false,
  claim_statements boolean NOT NULL DEFAULT false,
  lexical boolean NOT NULL DEFAULT true,
  vector boolean NOT NULL DEFAULT false,
  text_search_config text NOT NULL DEFAULT 'simple' CHECK (text_search_config ~ '^[a-z_]{1,63}$'),
  processing_regions text[] NOT NULL DEFAULT '{}' CHECK (cardinality(processing_regions) <= 16),
  credential_id text NOT NULL CHECK (char_length(credential_id) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, version),
  FOREIGN KEY (space_id, collection_id) REFERENCES collections(space_id, collection_id),
  FOREIGN KEY (space_id, collection_id, previous_version)
    REFERENCES retrieval_policies(space_id, collection_id, version),
  -- Embedding needs somewhere it may be processed.
  CHECK (NOT vector OR cardinality(processing_regions) > 0)
);
CREATE TRIGGER retrieval_policies_immutable BEFORE UPDATE OR DELETE ON retrieval_policies
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_fact_change();
CREATE TRIGGER retrieval_policies_no_truncate BEFORE TRUNCATE ON retrieval_policies
  FOR EACH STATEMENT EXECUTE FUNCTION reject_retrieval_fact_change();

-- Each record field is a distinct JSON Pointer of at most 256 bytes, each
-- region a distinct lowercase label, and the text search configuration one of
-- PostgreSQL's built-in ones, so a search_path cannot swap it. Checked by a
-- trigger rather than a CHECK function, so writers need no routine grant.
CREATE FUNCTION stateplane_check_retrieval_policy() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.record_fields) f
      WHERE f IS NULL OR f !~ '^(/([^~/]|~[01])*)+$' OR octet_length(f) > 256)
    OR (SELECT count(DISTINCT f) <> count(*) FROM unnest(NEW.record_fields) f) THEN
    RAISE EXCEPTION 'record fields are distinct JSON Pointers of at most 256 bytes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'retrieval_policies_record_fields';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.processing_regions) r WHERE r IS NULL OR r !~ '^[a-z0-9][a-z0-9-]{0,62}$')
    OR (SELECT count(DISTINCT r) <> count(*) FROM unnest(NEW.processing_regions) r) THEN
    RAISE EXCEPTION 'processing regions are distinct lowercase labels'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'retrieval_policies_processing_regions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_ts_config WHERE cfgname = NEW.text_search_config
      AND cfgnamespace = 'pg_catalog'::regnamespace) THEN
    RAISE EXCEPTION 'unknown text search configuration %', NEW.text_search_config
      USING ERRCODE = 'check_violation', CONSTRAINT = 'retrieval_policies_text_search_config';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_check_retrieval_policy() FROM PUBLIC;
CREATE TRIGGER retrieval_policies_valid BEFORE INSERT ON retrieval_policies
  FOR EACH ROW EXECUTE FUNCTION stateplane_check_retrieval_policy();

-- One mutable row per collection with a policy: its current (highest) policy
-- version and the highest generation number it has allocated. Only
-- owner-rights triggers write it. Publishing a policy and starting a generation
-- both update lock this row, and a vector chunk or checkpoint share locks it to
-- read the current policy, so they serialize: a writer whose snapshot predates
-- a committed change of the row fails with a serialization error under
-- REPEATABLE READ, and under READ COMMITTED waits and checks the committed row.
CREATE TABLE retrieval_collection_heads (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  policy_version bigint NOT NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  PRIMARY KEY (space_id, collection_id),
  FOREIGN KEY (space_id, collection_id, policy_version) REFERENCES retrieval_policies(space_id, collection_id, version)
);

-- Versions are published one at a time in order, whatever the statement's
-- shape: each inserted row must be the successor of the head's version when
-- its trigger runs (rows of one statement run in their insertion order), so
-- the head only advances and always names the highest version. The
-- self-referencing key alone is checked at statement end, so it would accept
-- versions 3 then 2 in one statement.
CREATE FUNCTION stateplane_publish_retrieval_policy() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_version bigint;
BEGIN
  SELECT h.policy_version INTO current_version FROM public.retrieval_collection_heads h
    WHERE h.space_id = NEW.space_id AND h.collection_id = NEW.collection_id FOR UPDATE;
  IF NEW.version <> COALESCE(current_version, 0) + 1 THEN
    RAISE EXCEPTION 'retrieval policy version % does not follow the current version %', NEW.version, COALESCE(current_version, 0)
      USING ERRCODE = 'check_violation', CONSTRAINT = 'retrieval_policies_order';
  END IF;
  IF current_version IS NULL THEN
    INSERT INTO public.retrieval_collection_heads(space_id, collection_id, policy_version)
      VALUES (NEW.space_id, NEW.collection_id, NEW.version);
  ELSE
    UPDATE public.retrieval_collection_heads h SET policy_version = NEW.version
      WHERE h.space_id = NEW.space_id AND h.collection_id = NEW.collection_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_publish_retrieval_policy() FROM PUBLIC;
CREATE TRIGGER retrieval_policies_publish AFTER INSERT ON retrieval_policies
  FOR EACH ROW EXECUTE FUNCTION stateplane_publish_retrieval_policy();

-- The ANN strategy for each embedding dimension the cell accepts. A vector
-- generation must name a recorded dimension. HNSW strategies have a partial
-- expression index below; `exact` dimensions are above pgvector's 2,000
-- dimension limit for indexing the `vector` type and are scanned exactly
-- within a generation's filters. Evidence: docs/retrieval-projections.md.
CREATE TABLE vector_index_strategies (
  dimensions integer PRIMARY KEY CHECK (dimensions BETWEEN 1 AND 16000),
  method text NOT NULL CHECK (method IN ('hnsw', 'exact')),
  distance text NOT NULL CHECK (distance IN ('cosine')),
  index_name text UNIQUE,
  hnsw_m integer,
  hnsw_ef_construction integer,
  evidence text NOT NULL CHECK (char_length(evidence) > 0 AND octet_length(evidence) <= 1024),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((method = 'hnsw') = (index_name IS NOT NULL)),
  CHECK ((method = 'hnsw') = (hnsw_m IS NOT NULL) AND (hnsw_m IS NULL) = (hnsw_ef_construction IS NULL)),
  CHECK (method <> 'hnsw' OR (dimensions <= 2000 AND hnsw_m BETWEEN 2 AND 100
    AND hnsw_ef_construction BETWEEN 2 * hnsw_m AND 1000))
);
INSERT INTO vector_index_strategies(dimensions, method, distance, index_name, hnsw_m, hnsw_ef_construction, evidence)
VALUES
  (384, 'hnsw', 'cosine', 'vector_chunks_hnsw_384', 16, 64, 'docs/retrieval-projections.md#ann-index-strategy'),
  (768, 'hnsw', 'cosine', 'vector_chunks_hnsw_768', 16, 64, 'docs/retrieval-projections.md#ann-index-strategy'),
  (1024, 'hnsw', 'cosine', 'vector_chunks_hnsw_1024', 16, 64, 'docs/retrieval-projections.md#ann-index-strategy'),
  (1536, 'hnsw', 'cosine', 'vector_chunks_hnsw_1536', 16, 64, 'docs/retrieval-projections.md#ann-index-strategy'),
  (3072, 'exact', 'cosine', NULL, NULL, NULL, 'docs/retrieval-projections.md#ann-index-strategy');

-- A versioned build of one collection's projections under one policy version
-- and, for vectors, one embedder. It moves forward only: building, then
-- verifying, then active, then retired; building or verifying may be
-- abandoned to retired. At most one generation of a collection is active and
-- at most one is being built or verified.
CREATE TABLE projection_generations (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  policy_version bigint NOT NULL,
  state text NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'verifying', 'active', 'retired')),
  embedder text CHECK (embedder ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  embedding_model text CHECK (char_length(embedding_model) > 0 AND octet_length(embedding_model) <= 256),
  model_version text CHECK (char_length(model_version) > 0 AND octet_length(model_version) <= 256),
  dimensions integer REFERENCES vector_index_strategies(dimensions),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verifying_at timestamptz,
  activated_at timestamptz,
  retired_at timestamptz,
  PRIMARY KEY (space_id, collection_id, generation),
  UNIQUE (space_id, collection_id, generation, policy_version),
  UNIQUE (space_id, collection_id, generation, embedder, embedding_model, model_version, dimensions),
  FOREIGN KEY (space_id, collection_id, policy_version) REFERENCES retrieval_policies(space_id, collection_id, version),
  CHECK ((embedder IS NULL) = (embedding_model IS NULL) AND (embedder IS NULL) = (model_version IS NULL)
    AND (embedder IS NULL) = (dimensions IS NULL)),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL)),
  CHECK (state <> 'building' OR (verifying_at IS NULL AND activated_at IS NULL)),
  CHECK (state <> 'verifying' OR (verifying_at IS NOT NULL AND activated_at IS NULL)),
  CHECK (state <> 'active' OR (verifying_at IS NOT NULL AND activated_at IS NOT NULL))
);
CREATE UNIQUE INDEX projection_generations_active ON projection_generations(space_id, collection_id)
  WHERE state = 'active';
CREATE UNIQUE INDEX projection_generations_pending ON projection_generations(space_id, collection_id)
  WHERE state IN ('building', 'verifying');
CREATE TRIGGER projection_generations_kept BEFORE DELETE ON projection_generations
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_fact_change();
CREATE TRIGGER projection_generations_no_truncate BEFORE TRUNCATE ON projection_generations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_retrieval_fact_change();

-- A generation starts building under the collection's current policy, with an
-- embedder exactly when that policy enables vectors, and numbers above every
-- earlier generation of its collection, both read from the collection's head
-- row under an update lock that it then advances. Each transition stamps its
-- own time; nothing else about a generation changes.
CREATE FUNCTION stateplane_guard_projection_generation() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  head record;
  stamps text[] := ARRAY['state', 'verifying_at', 'activated_at', 'retired_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT h.policy_version, h.generation INTO head FROM public.retrieval_collection_heads h
      WHERE h.space_id = NEW.space_id AND h.collection_id = NEW.collection_id FOR UPDATE;
    IF NEW.state <> 'building' OR NEW.verifying_at IS NOT NULL OR NEW.activated_at IS NOT NULL OR NEW.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'a projection generation starts building'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_generations_transition';
    END IF;
    IF head.policy_version IS DISTINCT FROM NEW.policy_version THEN
      RAISE EXCEPTION 'a projection generation is built under its collection''s current retrieval policy'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_generations_policy';
    END IF;
    IF (SELECT p.vector FROM public.retrieval_policies p WHERE p.space_id = NEW.space_id
        AND p.collection_id = NEW.collection_id AND p.version = NEW.policy_version) <> (NEW.embedder IS NOT NULL) THEN
      RAISE EXCEPTION 'a projection generation names an embedder exactly when its policy enables vectors'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_generations_policy';
    END IF;
    IF head.generation >= NEW.generation THEN
      RAISE EXCEPTION 'projection generations increase'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_generations_order';
    END IF;
    UPDATE public.retrieval_collection_heads h SET generation = NEW.generation
      WHERE h.space_id = NEW.space_id AND h.collection_id = NEW.collection_id;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - stamps) IS DISTINCT FROM (to_jsonb(OLD) - stamps)
    OR (OLD.state, NEW.state) NOT IN (('building', 'verifying'), ('building', 'retired'), ('verifying', 'active'),
      ('verifying', 'retired'), ('active', 'retired')) THEN
    RAISE EXCEPTION 'projection generation cannot move from % to %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_generations_transition';
  END IF;
  NEW.verifying_at := CASE WHEN NEW.state = 'verifying' THEN clock_timestamp() ELSE OLD.verifying_at END;
  NEW.activated_at := CASE WHEN NEW.state = 'active' THEN clock_timestamp() ELSE OLD.activated_at END;
  NEW.retired_at := CASE WHEN NEW.state = 'retired' THEN clock_timestamp() ELSE OLD.retired_at END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_projection_generation() FROM PUBLIC;
CREATE TRIGGER projection_generations_transition BEFORE INSERT OR UPDATE ON projection_generations
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_projection_generation();

-- The projected state of one canonical Ref in one generation: the
-- authoritative revision (and, for a source, extraction version) its chunks
-- were built from, or that it was deleted. A Ref only moves forward (a
-- deletion at the same revision is forward, with or without its extraction),
-- and a deleted Ref stays deleted. Chunks reference the live row at its revision,
-- so advancing or deleting a Ref requires removing its older chunks first;
-- embedding checkpoints reference the live row at any revision, so deleting a
-- Ref also requires removing its checkpoints first.
CREATE TABLE projection_refs (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  generation bigint NOT NULL,
  ref_kind text NOT NULL CHECK (ref_kind IN ('record', 'source', 'claim')),
  ref_id text NOT NULL CHECK (char_length(ref_id) > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  extraction_version bigint CHECK (extraction_version > 0),
  deleted boolean NOT NULL DEFAULT false,
  live boolean GENERATED ALWAYS AS (NOT deleted) STORED,
  record_id text GENERATED ALWAYS AS (CASE WHEN ref_kind = 'record' THEN ref_id END) STORED,
  entity_kind text GENERATED ALWAYS AS (CASE WHEN ref_kind <> 'record' THEN ref_kind END) STORED,
  entity_id text GENERATED ALWAYS AS (CASE WHEN ref_kind <> 'record' THEN ref_id END) STORED,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, generation, ref_kind, ref_id),
  UNIQUE (space_id, collection_id, generation, ref_kind, ref_id, revision, live),
  UNIQUE (space_id, collection_id, generation, ref_kind, ref_id, live),
  UNIQUE (space_id, collection_id, generation, ref_kind, ref_id, extraction_version),
  FOREIGN KEY (space_id, collection_id, generation)
    REFERENCES projection_generations(space_id, collection_id, generation),
  -- Checked at COMMIT, like projection heads, so applying takes no key-share
  -- lock on authority rows while it runs.
  FOREIGN KEY (space_id, collection_id, record_id) REFERENCES records(space_id, collection_id, record_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (space_id, collection_id, entity_kind, entity_id)
    REFERENCES entity_refs(space_id, collection_id, kind, entity_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (ref_kind = 'source' OR extraction_version IS NULL),
  CHECK (ref_kind <> 'source' OR deleted OR extraction_version IS NOT NULL)
);
-- Deleting a record or identity checks these foreign keys from the
-- referencing side, once per deleted row (the space purge deletes every one
-- at commit); without an index on the referencing columns each check scans the
-- whole table.
CREATE INDEX projection_refs_record ON projection_refs(space_id, collection_id, record_id)
  WHERE record_id IS NOT NULL;
CREATE INDEX projection_refs_entity ON projection_refs(space_id, collection_id, entity_kind, entity_id)
  WHERE entity_kind IS NOT NULL;
CREATE TRIGGER projection_refs_kept BEFORE DELETE ON projection_refs
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_fact_change();
CREATE TRIGGER projection_refs_no_truncate BEFORE TRUNCATE ON projection_refs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_retrieval_fact_change();

-- A Ref removed from a generation, recorded after its chunks are gone and its
-- authoritative Ref is deleted. The receipt references the Ref's deleted
-- `projection_refs` row at the same revision. That row is the one fence a
-- receipt and an apply or checkpoint share: deleting the Ref is a write to it
-- (an apply or checkpoint with an older snapshot then fails with a
-- serialization error, the order check or its foreign key), a deleted row
-- never changes again and its key admits no live row, so the receipt is final
-- in that generation under every isolation level. It
-- says nothing about other generations, authority rows, original bytes or
-- backups.
CREATE TABLE projection_deletion_receipts (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  generation bigint NOT NULL,
  ref_kind text NOT NULL CHECK (ref_kind IN ('record', 'source', 'claim')),
  ref_id text NOT NULL CHECK (char_length(ref_id) > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  live boolean NOT NULL GENERATED ALWAYS AS (false) STORED,
  chunks_removed integer NOT NULL CHECK (chunks_removed >= 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, collection_id, generation, ref_kind, ref_id),
  FOREIGN KEY (space_id, collection_id, generation)
    REFERENCES projection_generations(space_id, collection_id, generation),
  CONSTRAINT projection_deletion_receipts_deleted_ref FOREIGN KEY (space_id, collection_id, generation, ref_kind, ref_id, revision, live)
    REFERENCES projection_refs(space_id, collection_id, generation, ref_kind, ref_id, revision, live)
);
CREATE TRIGGER projection_deletion_receipts_immutable BEFORE UPDATE OR DELETE ON projection_deletion_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_fact_change();
CREATE TRIGGER projection_deletion_receipts_no_truncate BEFORE TRUNCATE ON projection_deletion_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_retrieval_fact_change();

-- Nothing is written to a retired generation; the generation row is share
-- locked, so retiring waits for writers already in it. A receipt also needs
-- the authoritative Ref deleted; its foreign key needs the projected Ref
-- deleted at the receipt's revision.
CREATE FUNCTION stateplane_guard_projection_ref() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  generation_state text;
BEGIN
  SELECT g.state INTO generation_state FROM public.projection_generations g WHERE g.space_id = NEW.space_id
    AND g.collection_id = NEW.collection_id AND g.generation = NEW.generation FOR SHARE;
  IF generation_state = 'retired' THEN
    RAISE EXCEPTION 'projection generation % is retired', NEW.generation
      USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_generations_retired';
  END IF;
  IF TG_TABLE_NAME = 'projection_deletion_receipts' THEN
    IF NOT EXISTS (SELECT 1 FROM public.records r WHERE NEW.ref_kind = 'record' AND r.space_id = NEW.space_id
          AND r.collection_id = NEW.collection_id AND r.record_id = NEW.ref_id AND r.tombstone)
        AND NOT EXISTS (SELECT 1 FROM public.entity_refs e WHERE e.space_id = NEW.space_id AND e.collection_id = NEW.collection_id
          AND e.kind = NEW.ref_kind AND e.entity_id = NEW.ref_id AND e.tombstone) THEN
      RAISE EXCEPTION 'only a deleted authoritative Ref has a deletion receipt'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_deletion_receipts_authority';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.space_id, NEW.collection_id, NEW.generation, NEW.ref_kind, NEW.ref_id)
        IS DISTINCT FROM (OLD.space_id, OLD.collection_id, OLD.generation, OLD.ref_kind, OLD.ref_id) OR OLD.deleted
      OR (NEW.revision, NEW.deleted, COALESCE(NEW.extraction_version, 0))
        <= (OLD.revision, OLD.deleted, COALESCE(OLD.extraction_version, 0)) THEN
      RAISE EXCEPTION 'a projected Ref only moves forward, and a deleted Ref stays deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_refs_order';
    END IF;
    NEW.applied_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_projection_ref() FROM PUBLIC;
CREATE TRIGGER projection_refs_order BEFORE INSERT OR UPDATE ON projection_refs
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_projection_ref();
CREATE TRIGGER projection_deletion_receipts_order BEFORE INSERT ON projection_deletion_receipts
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_projection_ref();

-- Lexical chunks: a code-point range of one configured text of a Ref at its
-- projected revision. `content` is exactly that range; `tsv` is computed from
-- it with the generation's policy configuration on insert. For a source,
-- the range is in its extraction's content, and the optional source range is
-- its position in the original.
CREATE TABLE lexical_chunks (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  generation bigint NOT NULL,
  ref_kind text NOT NULL CHECK (ref_kind IN ('record', 'source', 'claim')),
  ref_id text NOT NULL,
  revision bigint NOT NULL,
  extraction_version bigint,
  live boolean NOT NULL GENERATED ALWAYS AS (true) STORED,
  policy_version bigint NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  field text CHECK (octet_length(field) <= 256),
  content_start bigint NOT NULL,
  content_end bigint NOT NULL,
  source_start bigint,
  source_end bigint,
  content text NOT NULL CHECK (octet_length(content) <= 65536),
  tsv tsvector NOT NULL DEFAULT ''::tsvector,
  PRIMARY KEY (space_id, collection_id, generation, ref_kind, ref_id, chunk_index),
  FOREIGN KEY (space_id, collection_id, generation, ref_kind, ref_id, revision, live)
    REFERENCES projection_refs(space_id, collection_id, generation, ref_kind, ref_id, revision, live),
  FOREIGN KEY (space_id, collection_id, generation, ref_kind, ref_id, extraction_version)
    REFERENCES projection_refs(space_id, collection_id, generation, ref_kind, ref_id, extraction_version),
  FOREIGN KEY (space_id, collection_id, generation, policy_version)
    REFERENCES projection_generations(space_id, collection_id, generation, policy_version),
  CHECK ((ref_kind = 'record') = (field IS NOT NULL)),
  CHECK ((ref_kind = 'source') = (extraction_version IS NOT NULL)),
  CHECK (content_start >= 0 AND content_end - content_start = char_length(content) AND content_end > content_start),
  CHECK ((source_start IS NULL) = (source_end IS NULL)),
  CHECK (source_start IS NULL OR (ref_kind = 'source' AND source_start >= 0 AND source_start <= source_end))
);
CREATE INDEX lexical_chunks_tsv ON lexical_chunks USING gin (tsv);

-- Vector chunks carry the same Ref, revision, generation, offsets and policy,
-- the embedder, model, model version and dimensions of their generation, the
-- region the embedding was processed in, and the digest of the embedded text,
-- so a reread can tell whether authority still holds that text.
CREATE TABLE vector_chunks (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  generation bigint NOT NULL,
  ref_kind text NOT NULL CHECK (ref_kind IN ('record', 'source', 'claim')),
  ref_id text NOT NULL,
  revision bigint NOT NULL,
  extraction_version bigint,
  live boolean NOT NULL GENERATED ALWAYS AS (true) STORED,
  policy_version bigint NOT NULL,
  embedder text NOT NULL,
  embedding_model text NOT NULL,
  model_version text NOT NULL,
  dimensions integer NOT NULL,
  processing_region text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  field text CHECK (octet_length(field) <= 256),
  content_start bigint NOT NULL,
  content_end bigint NOT NULL,
  source_start bigint,
  source_end bigint,
  content_sha256 stateplane_sha256 NOT NULL,
  embedding vector NOT NULL,
  PRIMARY KEY (space_id, collection_id, generation, ref_kind, ref_id, chunk_index),
  FOREIGN KEY (space_id, collection_id, generation, ref_kind, ref_id, revision, live)
    REFERENCES projection_refs(space_id, collection_id, generation, ref_kind, ref_id, revision, live),
  FOREIGN KEY (space_id, collection_id, generation, ref_kind, ref_id, extraction_version)
    REFERENCES projection_refs(space_id, collection_id, generation, ref_kind, ref_id, extraction_version),
  FOREIGN KEY (space_id, collection_id, generation, policy_version)
    REFERENCES projection_generations(space_id, collection_id, generation, policy_version),
  FOREIGN KEY (space_id, collection_id, generation, embedder, embedding_model, model_version, dimensions)
    REFERENCES projection_generations(space_id, collection_id, generation, embedder, embedding_model, model_version, dimensions),
  CHECK ((ref_kind = 'record') = (field IS NOT NULL)),
  CHECK ((ref_kind = 'source') = (extraction_version IS NOT NULL)),
  CHECK (content_start >= 0 AND content_end > content_start),
  CHECK ((source_start IS NULL) = (source_end IS NULL)),
  CHECK (source_start IS NULL OR (ref_kind = 'source' AND source_start >= 0 AND source_start <= source_end))
);
-- One HNSW index per recorded dimension; a query uses it only with the same
-- cast and `dimensions` predicate.
CREATE INDEX vector_chunks_hnsw_384 ON vector_chunks USING hnsw ((embedding::vector(384)) vector_cosine_ops)
  WITH (m = 16, ef_construction = 64) WHERE dimensions = 384;
CREATE INDEX vector_chunks_hnsw_768 ON vector_chunks USING hnsw ((embedding::vector(768)) vector_cosine_ops)
  WITH (m = 16, ef_construction = 64) WHERE dimensions = 768;
CREATE INDEX vector_chunks_hnsw_1024 ON vector_chunks USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
  WITH (m = 16, ef_construction = 64) WHERE dimensions = 1024;
CREATE INDEX vector_chunks_hnsw_1536 ON vector_chunks USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
  WITH (m = 16, ef_construction = 64) WHERE dimensions = 1536;

-- Embeddings computed outside any SQL transaction and saved before they are
-- applied, so an interrupted or retried preparation resumes instead of
-- embedding the same chunk again. A checkpoint is keyed by the Ref's target
-- revision; applying moves it into `vector_chunks` and removes it. It
-- references the Ref's live `projection_refs` row in its generation, whatever
-- revision that row is at, so a worker records the Ref in the generation
-- before saving checkpoints (a Ref projected for the first time at its target
-- revision, with its chunks to follow). That row is the checkpoint's fence
-- with a deletion, as it is for chunks: deleting the Ref is refused while a
-- checkpoint references it (a foreign key violation, or a serialization error
-- for a checkpoint the deletion's snapshot cannot see), and no checkpoint is
-- saved for a deleted or unrecorded Ref.
CREATE TABLE embedding_checkpoints (
  space_id text NOT NULL,
  collection_id text NOT NULL,
  generation bigint NOT NULL,
  ref_kind text NOT NULL CHECK (ref_kind IN ('record', 'source', 'claim')),
  ref_id text NOT NULL CHECK (char_length(ref_id) > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  extraction_version bigint CHECK (extraction_version > 0),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content_sha256 stateplane_sha256 NOT NULL,
  embedder text NOT NULL,
  embedding_model text NOT NULL,
  model_version text NOT NULL,
  dimensions integer NOT NULL,
  processing_region text NOT NULL,
  embedding vector NOT NULL,
  live boolean NOT NULL GENERATED ALWAYS AS (true) STORED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (space_id, collection_id, generation, embedder, embedding_model, model_version, dimensions)
    REFERENCES projection_generations(space_id, collection_id, generation, embedder, embedding_model, model_version, dimensions),
  CONSTRAINT embedding_checkpoints_live_ref FOREIGN KEY (space_id, collection_id, generation, ref_kind, ref_id, live)
    REFERENCES projection_refs(space_id, collection_id, generation, ref_kind, ref_id, live),
  CHECK ((ref_kind = 'source') = (extraction_version IS NOT NULL))
);
CREATE UNIQUE INDEX embedding_checkpoints_chunk ON embedding_checkpoints(space_id, collection_id, generation, ref_kind,
  ref_id, revision, COALESCE(extraction_version, 0), chunk_index);

-- Chunks and checkpoints are immutable; a new revision replaces them.
CREATE TRIGGER lexical_chunks_immutable BEFORE UPDATE ON lexical_chunks
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_fact_change();
CREATE TRIGGER vector_chunks_immutable BEFORE UPDATE ON vector_chunks
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_fact_change();
CREATE TRIGGER embedding_checkpoints_immutable BEFORE UPDATE ON embedding_checkpoints
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_fact_change();

-- A chunk or checkpoint is written only into a generation that is not
-- retired, only for content its policy configures, and only by a projection
-- its policy enables. A lexical chunk's `tsv` is always derived from its
-- content; an embedding has its generation's dimensions and was processed in
-- a region both its generation's policy and the collection's current policy
-- allow. The current policy is read from the collection's head row under a
-- share lock, so publishing a policy waits for embedders already writing and
-- an embedder that meets a newer policy is checked against it (or, under
-- REPEATABLE READ, fails with a serialization error).
CREATE FUNCTION stateplane_guard_projection_chunk() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  policy record;
  current_version bigint;
BEGIN
  SELECT g.state AS generation_state, p.version, p.record_fields, p.source_content, p.claim_statements, p.lexical,
      p.vector, p.text_search_config, p.processing_regions
    INTO policy FROM public.projection_generations g
    JOIN public.retrieval_policies p ON p.space_id = g.space_id AND p.collection_id = g.collection_id AND p.version = g.policy_version
    WHERE g.space_id = NEW.space_id AND g.collection_id = NEW.collection_id AND g.generation = NEW.generation
    FOR SHARE OF g;
  IF NOT FOUND THEN
    RETURN NEW; -- The generation foreign key reports it.
  END IF;
  IF policy.generation_state = 'retired' THEN
    RAISE EXCEPTION 'projection generation % is retired', NEW.generation
      USING ERRCODE = 'check_violation', CONSTRAINT = 'projection_generations_retired';
  END IF;
  IF (NEW.ref_kind = 'source' AND NOT policy.source_content) OR (NEW.ref_kind = 'claim' AND NOT policy.claim_statements)
    OR (NEW.ref_kind = 'record' AND (CASE WHEN TG_TABLE_NAME = 'embedding_checkpoints' THEN cardinality(policy.record_fields) = 0
      ELSE NOT (to_jsonb(NEW) ->> 'field') = ANY(policy.record_fields) END)) THEN
    RAISE EXCEPTION 'retrieval policy % does not configure this content', policy.version
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_configured';
  END IF;
  IF TG_TABLE_NAME = 'lexical_chunks' THEN
    IF NOT policy.lexical THEN
      RAISE EXCEPTION 'retrieval policy % does not enable lexical projection', policy.version
        USING ERRCODE = 'check_violation', CONSTRAINT = 'lexical_chunks_configured';
    END IF;
    NEW.tsv := to_tsvector(('pg_catalog.' || policy.text_search_config)::regconfig, NEW.content);
    RETURN NEW;
  END IF;
  IF NOT policy.vector THEN
    RAISE EXCEPTION 'retrieval policy % does not enable vector projection', policy.version
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_configured';
  END IF;
  -- Two statements, not a join: under READ COMMITTED the second reads the
  -- policy the locked head row names after any wait.
  SELECT h.policy_version INTO current_version FROM public.retrieval_collection_heads h
    WHERE h.space_id = NEW.space_id AND h.collection_id = NEW.collection_id FOR SHARE;
  IF NOT NEW.processing_region = ANY(policy.processing_regions) OR NOT EXISTS (SELECT 1 FROM public.retrieval_policies p
      WHERE p.space_id = NEW.space_id AND p.collection_id = NEW.collection_id AND p.version = current_version
        AND NEW.processing_region = ANY(p.processing_regions)) THEN
    RAISE EXCEPTION 'retrieval policies % and % do not both allow processing in %', policy.version, current_version,
      NEW.processing_region USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_region';
  END IF;
  IF public.vector_dims(NEW.embedding) <> NEW.dimensions THEN
    RAISE EXCEPTION 'embedding has % dimensions, not %', public.vector_dims(NEW.embedding), NEW.dimensions
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_dimensions';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_projection_chunk() FROM PUBLIC;
CREATE TRIGGER lexical_chunks_policy BEFORE INSERT ON lexical_chunks
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_projection_chunk();
CREATE TRIGGER vector_chunks_policy BEFORE INSERT ON vector_chunks
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_projection_chunk();
CREATE TRIGGER embedding_checkpoints_policy BEFORE INSERT ON embedding_checkpoints
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_projection_chunk();

-- Projection work for sources and claims, enqueued by the authoritative write
-- itself: a new extraction version, every claim revision (create, revise and
-- review each insert one) and the deletion of a source or claim. Record
-- writes already enqueue `projection_outbox` work in their own transaction.
-- `placement_generation` is the space's placement generation at commit.
-- Delivery fields are the only mutable columns, and delivery is final.
CREATE TABLE retrieval_outbox (
  job_id text PRIMARY KEY DEFAULT ('rpj_' || gen_random_uuid())
    CHECK (job_id ~ '^rpj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  space_id text NOT NULL,
  collection_id text NOT NULL,
  ref_kind text NOT NULL CHECK (ref_kind IN ('source', 'claim')),
  ref_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  extraction_version bigint CHECK (extraction_version > 0),
  operation text NOT NULL CHECK (operation IN ('upsert', 'delete')),
  placement_generation bigint NOT NULL CHECK (placement_generation > 0),
  delivery_state text NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'delivered')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  last_error text CHECK (char_length(last_error) > 0 AND octet_length(last_error) <= 1024),
  FOREIGN KEY (space_id, collection_id, ref_kind, ref_id) REFERENCES entity_refs(space_id, collection_id, kind, entity_id),
  CHECK ((delivery_state = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((ref_kind = 'source' AND operation = 'upsert') = (extraction_version IS NOT NULL))
);
-- Each authoritative change is one unit of work. The index also serves the
-- space purge and the erasure check, which lead with `space_id`.
CREATE UNIQUE INDEX retrieval_outbox_work ON retrieval_outbox(space_id, collection_id, ref_kind, ref_id, revision,
  COALESCE(extraction_version, 0), operation);
CREATE INDEX retrieval_outbox_pending ON retrieval_outbox(space_id, collection_id, available_at, job_id)
  WHERE delivery_state = 'pending';

CREATE FUNCTION stateplane_guard_retrieval_outbox() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  delivery text[] := ARRAY['delivery_state', 'attempts', 'available_at', 'delivered_at', 'last_error'];
BEGIN
  IF (to_jsonb(NEW) - delivery) IS DISTINCT FROM (to_jsonb(OLD) - delivery) OR OLD.delivery_state = 'delivered'
    OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'retrieval work changes only its pending delivery'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'retrieval_outbox_transition';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_guard_retrieval_outbox() FROM PUBLIC;
CREATE TRIGGER retrieval_outbox_transition BEFORE UPDATE ON retrieval_outbox
  FOR EACH ROW EXECUTE FUNCTION stateplane_guard_retrieval_outbox();
CREATE TRIGGER retrieval_outbox_kept BEFORE DELETE ON retrieval_outbox
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_fact_change();
CREATE TRIGGER retrieval_outbox_no_truncate BEFORE TRUNCATE ON retrieval_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION reject_retrieval_fact_change();

-- Owner rights let a writer enqueue without outbox privileges. Exactly one
-- unit of work is enqueued, or the authoritative write fails with it.
CREATE FUNCTION stateplane_enqueue_retrieval_work() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'extraction_versions' THEN
    INSERT INTO public.retrieval_outbox(space_id, collection_id, ref_kind, ref_id, revision, extraction_version, operation,
        placement_generation)
      SELECT NEW.space_id, NEW.collection_id, 'source', NEW.source_id, e.revision, NEW.version, 'upsert', s.placement_generation
      FROM public.entity_refs e JOIN public.spaces s ON s.space_id = e.space_id
      WHERE e.space_id = NEW.space_id AND e.collection_id = NEW.collection_id AND e.kind = 'source' AND e.entity_id = NEW.source_id;
  ELSIF TG_TABLE_NAME = 'claim_revisions' THEN
    INSERT INTO public.retrieval_outbox(space_id, collection_id, ref_kind, ref_id, revision, operation, placement_generation)
      SELECT NEW.space_id, NEW.collection_id, 'claim', NEW.claim_id, NEW.revision, 'upsert', s.placement_generation
      FROM public.spaces s WHERE s.space_id = NEW.space_id;
  ELSE
    INSERT INTO public.retrieval_outbox(space_id, collection_id, ref_kind, ref_id, revision, operation, placement_generation)
      SELECT NEW.space_id, NEW.collection_id, NEW.kind, NEW.entity_id, NEW.revision, 'delete', s.placement_generation
      FROM public.spaces s WHERE s.space_id = NEW.space_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retrieval work could not be enqueued'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'retrieval_outbox_enqueue';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_enqueue_retrieval_work() FROM PUBLIC;
CREATE TRIGGER extraction_versions_retrieval AFTER INSERT ON extraction_versions
  FOR EACH ROW EXECUTE FUNCTION stateplane_enqueue_retrieval_work();
CREATE TRIGGER claim_revisions_retrieval AFTER INSERT ON claim_revisions
  FOR EACH ROW EXECUTE FUNCTION stateplane_enqueue_retrieval_work();
CREATE TRIGGER entity_refs_retrieval AFTER UPDATE OF tombstone ON entity_refs
  FOR EACH ROW WHEN (NEW.tombstone AND NOT OLD.tombstone)
  EXECUTE FUNCTION stateplane_enqueue_retrieval_work();

-- Evidence written before this step: enqueue each live source's latest
-- extraction and each live claim's current revision, so the first build
-- sees them. Deleted evidence, and evidence of a space being erased, has
-- nothing to project: a purge already running migration 044's routine (whose
-- space is committed `deleting`, or `deleted` for an erasure repair) resumes
-- after this step with that routine, which removes no retrieval work, so no
-- work may reference its identities. A purge runs only once its space has
-- committed `deleting`, so the spaces the backfill enqueues for are first
-- share locked: an update of one of them (its lifecycle, policy or placement)
-- waits until this step commits, so its purge then runs the routine below, and
-- a change committed while this lock waited is seen by the recheck and the
-- backfill's snapshot, which skip the space. Those updates touch no table this
-- step locks, and a purge holds its space only once committed `deleting`,
-- which is skipped unlocked, so the wait cannot deadlock. Each statement reads
-- the identities once and, per live identity, one primary-key probe of its
-- latest extraction or current revision (a LATERAL ... LIMIT 1 is never
-- flattened into a scan), so extraction and claim history is never read; the
-- migrator bounds the identities read (scripts/migrate.mjs).
SELECT count(*) FROM (SELECT 1 FROM spaces s WHERE s.lifecycle NOT IN ('deleting', 'deleted')
  AND EXISTS (SELECT 1 FROM entity_refs e WHERE e.space_id = s.space_id AND e.kind IN ('source', 'claim') AND NOT e.tombstone)
  FOR SHARE OF s) locked;
INSERT INTO retrieval_outbox(space_id, collection_id, ref_kind, ref_id, revision, extraction_version, operation, placement_generation)
  SELECT e.space_id, e.collection_id, 'source', e.entity_id, e.revision, x.version, 'upsert', s.placement_generation
  FROM entity_refs e
  CROSS JOIN LATERAL (SELECT v.version FROM extraction_versions v WHERE v.space_id = e.space_id
    AND v.collection_id = e.collection_id AND v.source_id = e.entity_id ORDER BY v.version DESC LIMIT 1) x
  JOIN spaces s ON s.space_id = e.space_id AND s.lifecycle NOT IN ('deleting', 'deleted')
  WHERE e.kind = 'source' AND NOT e.tombstone;
INSERT INTO retrieval_outbox(space_id, collection_id, ref_kind, ref_id, revision, operation, placement_generation)
  SELECT e.space_id, e.collection_id, 'claim', e.entity_id, e.revision, 'upsert', s.placement_generation
  FROM entity_refs e
  CROSS JOIN LATERAL (SELECT 1 FROM claim_revisions r WHERE r.space_id = e.space_id AND r.collection_id = e.collection_id
    AND r.claim_id = e.entity_id AND r.revision = e.revision LIMIT 1) x
  JOIN spaces s ON s.space_id = e.space_id AND s.lifecycle NOT IN ('deleting', 'deleted')
  WHERE e.kind = 'claim' AND NOT e.tombstone;

-- Space erasure removes projections and retrieval work before the records,
-- identities and collections they reference, as migration 044's routine did.
CREATE OR REPLACE FUNCTION stateplane_purge_space(p_space_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  writers_end timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.spaces WHERE space_id=p_space_id AND lifecycle='deleting' FOR UPDATE) THEN
    RAISE EXCEPTION 'space is not deleting';
  END IF;
  -- An upload grant can still write the space's keys until it ends, after its rows are gone.
  SELECT COALESCE(max(expires_at), clock_timestamp()) INTO writers_end FROM public.source_upload_grants WHERE space_id=p_space_id;
  PERFORM set_config('stateplane.erasing_space', p_space_id, true);
  DELETE FROM public.batch_operations WHERE space_id=p_space_id;
  DELETE FROM public.projection_reconciliations WHERE space_id=p_space_id;
  DELETE FROM public.projection_heads WHERE space_id=p_space_id;
  DELETE FROM public.outbox_space_rotation WHERE space_id=p_space_id;
  DELETE FROM public.projection_outbox WHERE space_id=p_space_id;
  DELETE FROM public.embedding_checkpoints WHERE space_id=p_space_id;
  DELETE FROM public.vector_chunks WHERE space_id=p_space_id;
  DELETE FROM public.lexical_chunks WHERE space_id=p_space_id;
  DELETE FROM public.projection_deletion_receipts WHERE space_id=p_space_id;
  DELETE FROM public.projection_refs WHERE space_id=p_space_id;
  DELETE FROM public.projection_generations WHERE space_id=p_space_id;
  DELETE FROM public.retrieval_collection_heads WHERE space_id=p_space_id;
  DELETE FROM public.retrieval_policies WHERE space_id=p_space_id;
  DELETE FROM public.retrieval_outbox WHERE space_id=p_space_id;
  DELETE FROM public.receipt_reservation_scopes WHERE space_id=p_space_id;
  DELETE FROM public.receipt_reservations WHERE space_id=p_space_id;
  DELETE FROM public.idempotency_receipts WHERE space_id=p_space_id;
  DELETE FROM public.evidence_outbox WHERE space_id=p_space_id;
  DELETE FROM public.evidence_events WHERE space_id=p_space_id;
  DELETE FROM public.original_erasures WHERE space_id=p_space_id;
  DELETE FROM public.links WHERE space_id=p_space_id;
  DELETE FROM public.claim_evidence WHERE space_id=p_space_id;
  DELETE FROM public.claim_revisions WHERE space_id=p_space_id;
  DELETE FROM public.claims WHERE space_id=p_space_id;
  DELETE FROM public.source_upload_attempts WHERE space_id=p_space_id;
  DELETE FROM public.source_upload_grants WHERE space_id=p_space_id;
  DELETE FROM public.extraction_versions WHERE space_id=p_space_id;
  DELETE FROM public.original_objects WHERE space_id=p_space_id;
  DELETE FROM public.sources WHERE space_id=p_space_id;
  DELETE FROM public.record_tombstones WHERE space_id=p_space_id;
  DELETE FROM public.record_unique_keys WHERE space_id=p_space_id;
  DELETE FROM public.record_index_values WHERE space_id=p_space_id;
  DELETE FROM public.record_events WHERE space_id=p_space_id;
  DELETE FROM public.records WHERE space_id=p_space_id;
  DELETE FROM public.entity_refs WHERE space_id=p_space_id;
  DELETE FROM public.collection_grants WHERE space_id=p_space_id;
  DELETE FROM public.collection_unique_declarations WHERE space_id=p_space_id;
  DELETE FROM public.collection_index_declarations WHERE space_id=p_space_id;
  DELETE FROM public.collection_versions WHERE space_id=p_space_id;
  DELETE FROM public.collections WHERE space_id=p_space_id;
  DELETE FROM public.space_credentials WHERE space_id=p_space_id;
  DELETE FROM public.routing_nonces WHERE space_id=p_space_id;
  -- Every purge asks again, so a repaired erasure lists the space's keys anew.
  INSERT INTO public.space_erasures(space_id, writers_end_at) VALUES (p_space_id, writers_end)
    ON CONFLICT (space_id) DO UPDATE SET requested_at = clock_timestamp(), originals_removed_at = NULL,
      writers_end_at = greatest(space_erasures.writers_end_at, EXCLUDED.writers_end_at), next_attempt_at = clock_timestamp();
  UPDATE public.spaces SET lifecycle='deleted',policy_version=policy_version+1 WHERE space_id=p_space_id;
END;
$$;
