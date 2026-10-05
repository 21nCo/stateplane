-- A batch item and a caller-selected standalone key have separate receipt
-- identities, including their in-flight reservations. Existing operation
-- values remain valid; no receipt or reservation identity is rewritten.
ALTER TABLE public.idempotency_receipts
  DROP CONSTRAINT idempotency_receipts_operation_check;
ALTER TABLE public.idempotency_receipts
  ADD CONSTRAINT idempotency_receipts_operation_check
  CHECK (operation IN ('create','replace','patch','delete',
    'batch:create','batch:replace','batch:patch','batch:delete')) NOT VALID;

ALTER TABLE public.receipt_reservations
  DROP CONSTRAINT receipt_reservations_operation_check;
ALTER TABLE public.receipt_reservations
  ADD CONSTRAINT receipt_reservations_operation_check
  CHECK (operation IN ('create','replace','patch','delete',
    'batch:create','batch:replace','batch:patch','batch:delete')) NOT VALID;

ALTER TABLE public.receipt_reservation_scopes
  DROP CONSTRAINT receipt_reservation_scopes_operation_check;
ALTER TABLE public.receipt_reservation_scopes
  ADD CONSTRAINT receipt_reservation_scopes_operation_check
  CHECK (operation IN ('create','replace','patch','delete',
    'batch:create','batch:replace','batch:patch','batch:delete')) NOT VALID;
