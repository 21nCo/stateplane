-- Upgrade existing authority databases without rewriting IDs or outbox state.
CREATE FUNCTION reject_authority_fact_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'accepted authority facts are immutable';
END;
$$;
REVOKE ALL ON FUNCTION reject_authority_fact_update() FROM PUBLIC;
CREATE TRIGGER receipts_no_update BEFORE UPDATE ON idempotency_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_authority_fact_update();
CREATE TRIGGER collection_versions_immutable BEFORE UPDATE OR DELETE ON collection_versions
  FOR EACH ROW EXECUTE FUNCTION reject_authority_fact_update();
