-- Sync: remove DriverRegion join table and replace with Driver.regions array.
-- DriverRegion was the original many-to-many table for driver regions.
-- The schema evolved to use a simple String[] column on Driver instead.

-- 1. Drop FK constraint on DriverRegion
ALTER TABLE IF EXISTS "DriverRegion" DROP CONSTRAINT IF EXISTS "DriverRegion_driverId_fkey";

-- 2. Drop DriverRegion table
DROP TABLE IF EXISTS "DriverRegion";

-- 3. Add regions array to Driver (idempotent)
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "regions" TEXT[] NOT NULL DEFAULT '{}';

