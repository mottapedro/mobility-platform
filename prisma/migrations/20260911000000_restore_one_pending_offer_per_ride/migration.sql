-- Restore sequential dispatch uniqueness without replacing existing objects.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
-- Keep data stable through inspection and index creation.
LOCK TABLE public."RideOffer" IN SHARE MODE;

DO $migration$
DECLARE
  existing_oid oid := to_regclass('public."RideOffer_one_pending_per_ride"');
  equivalent boolean;
BEGIN
  IF existing_oid IS NULL THEN
    -- Duplicate PENDING rows must fail; no data repair is permitted.
    CREATE UNIQUE INDEX "RideOffer_one_pending_per_ride"
      ON public."RideOffer" ("rideRequestId") WHERE status = 'PENDING';
  ELSE
    SELECT c.relkind = 'i'
      AND i.indrelid = 'public."RideOffer"'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indislive AND i.indimmediate
      AND i.indnkeyatts = 1 AND i.indnatts = 1
      AND i.indexprs IS NULL AND i.indkey[0] = key_column.attnum
      AND am.amname = 'btree'
      AND op.opcdefault AND op.opcintype = key_column.atttypid
      AND i.indcollation[0] = key_column.attcollation
      AND pg_get_expr(i.indpred, i.indrelid, false) IN (
        '(status = ''PENDING''::"RideOfferStatus")',
        '(''PENDING''::"RideOfferStatus" = status)'
      )
    INTO equivalent
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_opclass op ON op.oid = i.indclass[0]
    JOIN pg_attribute key_column ON key_column.attrelid = i.indrelid
      AND key_column.attname = 'rideRequestId' AND NOT key_column.attisdropped
    JOIN pg_attribute status_column ON status_column.attrelid = i.indrelid
      AND status_column.attname = 'status' AND NOT status_column.attisdropped
      AND status_column.atttypid = 'public."RideOfferStatus"'::regtype
    WHERE c.oid = existing_oid;

    IF equivalent IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'ONE_PENDING_INDEX_INCOMPATIBLE: public.RideOffer_one_pending_per_ride'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END
$migration$;
COMMIT;
