-- Transient rows carry trusted schema scopes into PostgreSQL's deferred
-- constraint phase. A successful commit removes its row in the trigger;
-- failure rolls back schema versions, index facts, and the row together.
CREATE TABLE schema_commit_fences (
  nonce uuid PRIMARY KEY,
  space_id text NOT NULL,
  collection_id text NOT NULL,
  principal_id text NOT NULL,
  credential_id text NOT NULL,
  policy_version bigint NOT NULL,
  placement_generation bigint NOT NULL,
  FOREIGN KEY (space_id, collection_id) REFERENCES collections(space_id, collection_id)
);

CREATE FUNCTION check_schema_commit_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  authorized boolean;
BEGIN
  -- The space lock also serializes supported policy/grant revocation. The
  -- database clock is sampled in COMMIT's deferred-trigger phase, after any
  -- application-side pause following the last authorization statement.
  SELECT s.lifecycle = 'active' AND c.lifecycle = 'active'
    AND s.policy_version = NEW.policy_version
    AND s.placement_generation = NEW.placement_generation
    AND (s.owner_principal_id = NEW.principal_id OR
      (g.capabilities @> ARRAY['schema:write']::text[] AND
        (g.expires_at IS NULL OR g.expires_at > clock_timestamp())))
    INTO authorized
    FROM public.spaces s
    JOIN public.collections c ON c.space_id = s.space_id AND c.collection_id = NEW.collection_id
    LEFT JOIN public.collection_grants g ON g.space_id = c.space_id AND g.collection_id = c.collection_id
      AND g.credential_id = NEW.credential_id
    WHERE s.space_id = NEW.space_id
    FOR SHARE OF s;
  IF authorized IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'PZ002', MESSAGE = 'schema authorization expired at commit';
  END IF;
  DELETE FROM public.schema_commit_fences WHERE nonce = NEW.nonce;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION check_schema_commit_fence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER schema_commit_authorization
  AFTER INSERT ON schema_commit_fences DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_schema_commit_fence();
