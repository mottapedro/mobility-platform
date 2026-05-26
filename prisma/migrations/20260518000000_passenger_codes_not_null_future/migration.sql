-- ============================================================
-- Future migration: make referralCode and publicSlug NOT NULL
-- ============================================================
-- DO NOT APPLY until the backfill has been verified complete.
-- Steps before applying:
--   1. Run scripts/passenger/backfill-passenger-identity.ts
--   2. Verify zero rows: SELECT COUNT(*) FROM "Passenger" WHERE "referralCode" IS NULL OR "publicSlug" IS NULL;
--   3. Only then run this migration.
-- ============================================================
ALTER TABLE "Passenger"
ALTER COLUMN "referralCode"
SET
    NOT NULL;

ALTER TABLE "Passenger"
ALTER COLUMN "publicSlug"
SET
    NOT NULL;