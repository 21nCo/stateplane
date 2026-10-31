-- STA-35: a claim revision recorded with a regional key commits only while
-- that key may record it. The service checks every grant in its last
-- statement, but COMMIT is a separate round trip, so a grant or key could
-- expire between that statement and COMMIT. This check runs at COMMIT, after
-- the service's last statement, as migration 041 does for upload grants; a
-- refused COMMIT rolls back the claim, its revision, its evidence and its
-- current-revision pointer together.
-- Every claim write (create, revise, review) inserts exactly one revision, and
-- the revision says which write it was: revision 1 needs `claims:write`, a
-- later revision without a reviewer `claims:write` and `claims:read`, and a
-- review `claims:review` and `claims:read`. The key also needs `sources:read`
-- on every collection any revision of the claim cites. A revision recorded
-- by an owner session names no regional key; its provider decides that
-- session, as before.
CREATE FUNCTION stateplane_check_claim_authority() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  checked_at timestamptz := clock_timestamp();
  needed text[] := CASE WHEN NEW.reviewed_by IS NOT NULL THEN ARRAY['claims:review', 'claims:read']
    WHEN NEW.revision = 1 THEN ARRAY['claims:write'] ELSE ARRAY['claims:write', 'claims:read'] END;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.space_credentials WHERE space_id = NEW.space_id AND credential_id = NEW.credential_id) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    WITH live AS (SELECT g.collection_id, g.capabilities FROM public.space_credentials sc
      JOIN public.spaces s ON s.space_id = sc.space_id AND s.owner_principal_id = sc.owner_principal_id
      JOIN public.collection_grants g ON g.space_id = sc.space_id AND g.credential_id = sc.credential_id
      JOIN public.collections c ON c.space_id = g.space_id AND c.collection_id = g.collection_id
      WHERE sc.space_id = NEW.space_id AND sc.credential_id = NEW.credential_id AND c.lifecycle <> 'deleted'
        AND sc.activated_at IS NOT NULL AND sc.confirmed_at IS NOT NULL AND sc.revoked_at IS NULL AND sc.expires_at > checked_at
        AND (g.expires_at IS NULL OR g.expires_at > checked_at))
    SELECT 1 WHERE EXISTS (SELECT 1 FROM live WHERE live.collection_id = NEW.collection_id AND live.capabilities @> needed)
      AND NOT EXISTS (SELECT 1 FROM public.claim_evidence a WHERE a.space_id = NEW.space_id
        AND a.collection_id = NEW.collection_id AND a.claim_id = NEW.claim_id
        AND NOT EXISTS (SELECT 1 FROM live WHERE live.collection_id = a.source_collection_id
          AND 'sources:read' = ANY(live.capabilities)))) THEN
    RAISE EXCEPTION 'claim revision''s key lost the grants it needs before COMMIT'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'claim_revisions_authority';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION stateplane_check_claim_authority() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER claim_revisions_authority AFTER INSERT ON claim_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stateplane_check_claim_authority();
