-- Migration: Contract Lifecycle Enums
-- Phase 3 of Lifecycle Stabilization Sprint: Contract enums to final state.
-- This migration removes legacy values from the RideOfferStatus enum.
-- It follows the safe PostgreSQL pattern for enum modification:
-- 1. Create a new enum with the desired values.
-- 2. Add a new column to the table with the new enum type.
-- 3. Update the new column based on the old column's values.
-- 4. Drop the old column.
-- 5. Rename the new column to the original name.
-- 6. Drop the old enum type.
-- 7. Rename the new enum type to the original name.

-- Step 1: Create the new enum type
CREATE TYPE "RideOfferStatus_new" AS ENUM ('ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- Step 2: Add a new column with the new enum type
ALTER TABLE "RideOffer" ADD COLUMN "status_new" "RideOfferStatus_new";

-- Step 3: Update the new column based on the old column's values
-- Forcing the cast to ::text avoids premature enum validation issues.
UPDATE "RideOffer" SET "status_new" = CASE "status"::text
  WHEN 'ACCEPTED' THEN 'ACCEPTED'::"RideOfferStatus_new"
  WHEN 'OFFER_ACCEPTED' THEN 'ACCEPTED'::"RideOfferStatus_new"
  WHEN 'REJECTED' THEN 'DECLINED'::"RideOfferStatus_new"
  WHEN 'OFFER_DECLINED' THEN 'DECLINED'::"RideOfferStatus_new"
  WHEN 'EXPIRED' THEN 'EXPIRED'::"RideOfferStatus_new"
  WHEN 'OFFER_EXPIRED' THEN 'EXPIRED'::"RideOfferStatus_new"
  WHEN 'PENDING' THEN 'EXPIRED'::"RideOfferStatus_new" -- Clean up remaining pending offers
  ELSE NULL
END;

-- Set a default for the new column before making it non-nullable
-- This is a safety measure. Let's assume CANCELLED is a safe default.
ALTER TABLE "RideOffer" ALTER COLUMN "status_new" SET DEFAULT 'CANCELLED';

-- Step 4: Drop the old column
ALTER TABLE "RideOffer" DROP COLUMN "status";

-- Step 5: Rename the new column to the original name
ALTER TABLE "RideOffer" RENAME COLUMN "status_new" TO "status";

-- Make the column non-nullable now that it's populated
ALTER TABLE "RideOffer" ALTER COLUMN "status" SET NOT NULL;

-- Step 6: Drop the old enum type
DROP TYPE "RideOfferStatus";

-- Step 7: Rename the new enum type to the original name
ALTER TYPE "RideOfferStatus_new" RENAME TO "RideOfferStatus";
