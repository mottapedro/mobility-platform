-- Restore Driver.regions DEFAULT '{}' so nested creates (e.g. via test fixtures
-- and onboarding flows that don't yet collect region preferences) succeed.
-- Migration 20260526190329_add_driver_referred_event dropped this default
-- prematurely; the schema invariant is "a driver may have zero or more regions"
-- so an empty array is the semantically correct default. No existing rows are
-- modified.
ALTER TABLE "Driver"
ALTER COLUMN "regions"
SET DEFAULT '{}';