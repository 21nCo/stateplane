-- Keep the two unique-key probes and their savepoint recovery on the server.
-- A remote caller must not pay one network round trip per savepoint statement.
CREATE FUNCTION stateplane_try_reserve_receipt(
  p_space_id text, p_collection_id text, p_credential_id text,
  p_principal_id text, p_operation text, p_idempotency_key text)
RETURNS TABLE(reservation_state text, original_collection_id text)
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  prior_timeout text := current_setting('lock_timeout');
  candidate record;
  attempt integer;
BEGIN
  FOR attempt IN 1..3 LOOP
    BEGIN
      PERFORM set_config('lock_timeout', '50ms', true);
      INSERT INTO public.receipt_reservation_scopes
        (space_id, collection_id, credential_id, operation, idempotency_key)
        VALUES (p_space_id, p_collection_id, p_credential_id, p_operation, p_idempotency_key);
      INSERT INTO public.receipt_reservations
        (space_id, credential_id, operation, idempotency_key)
        VALUES (p_space_id, p_credential_id, p_operation, p_idempotency_key);
      PERFORM set_config('lock_timeout', prior_timeout, true);
      RETURN QUERY SELECT 'reserved'::text, NULL::text;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      -- The exception subtransaction rolls back both inserts and its SET LOCAL.
      NULL;
    END;

    FOR candidate IN
      SELECT c.collection_id FROM public.collections c
      JOIN public.spaces s ON s.space_id = c.space_id
      LEFT JOIN public.collection_grants g ON g.space_id = c.space_id
        AND g.collection_id = c.collection_id AND g.credential_id = p_credential_id
      WHERE c.space_id = p_space_id AND
        (s.owner_principal_id = p_principal_id OR
          (g.capabilities @> ARRAY['records:write']::text[] AND
            (g.expires_at IS NULL OR g.expires_at > clock_timestamp())))
      ORDER BY c.collection_id
    LOOP
      BEGIN
        PERFORM set_config('lock_timeout', '50ms', true);
        INSERT INTO public.receipt_reservation_scopes
          (space_id, collection_id, credential_id, operation, idempotency_key)
          VALUES (p_space_id, candidate.collection_id, p_credential_id, p_operation, p_idempotency_key);
        DELETE FROM public.receipt_reservation_scopes
          WHERE space_id = p_space_id AND collection_id = candidate.collection_id
            AND credential_id = p_credential_id AND operation = p_operation
            AND idempotency_key = p_idempotency_key;
        PERFORM set_config('lock_timeout', prior_timeout, true);
      EXCEPTION WHEN lock_not_available THEN
        -- The caller rechecks both scopes before disclosing pending state.
        RETURN QUERY SELECT 'pending'::text, candidate.collection_id;
        RETURN;
      END;
    END LOOP;
  END LOOP;
  RETURN QUERY SELECT 'unresolved'::text, NULL::text;
END $$;

REVOKE ALL ON FUNCTION stateplane_try_reserve_receipt(text,text,text,text,text,text) FROM PUBLIC;
