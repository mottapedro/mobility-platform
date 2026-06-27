-- Add Settlement.rootDriverId as a frozen snapshot of economic ownership.
-- Backfill existing settlements from their associated RideRequest.rootDriverId.
-- If a ride has no rootDriverId yet, the settlement is left with a placeholder
-- that must be reconciled by RootOwnershipProjectionService.

-- Step 1: ensure column exists (idempotent for environments that already have it)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'Settlement'
          AND column_name = 'rootDriverId'
    ) THEN
        ALTER TABLE "Settlement" ADD COLUMN "rootDriverId" TEXT;
    END IF;
END $$;

-- Step 2: backfill from RideRequest.rootDriverId
UPDATE "Settlement" s
SET "rootDriverId" = rr."rootDriverId"
FROM "RideRequest" rr
WHERE s."rideRequestId" = rr.id
  AND rr."rootDriverId" IS NOT NULL
  AND s."rootDriverId" IS NULL;

-- Step 3: set NOT NULL after backfill; any remaining NULLs will fail,
-- which is the desired signal that ownership reconciliation must be run first.
ALTER TABLE "Settlement" ALTER COLUMN "rootDriverId" SET NOT NULL;

-- Step 4: index for root-driver settlement queries
CREATE INDEX IF NOT EXISTS "Settlement_rootDriverId_idx" ON "Settlement" ("rootDriverId");
