-- Add peso_esforco (effort coefficient) to OperationalZone
-- This is an additive, non-destructive migration. The field is optional with default 1.0.

ALTER TABLE "OperationalZone" ADD COLUMN IF NOT EXISTS "peso_esforco" DOUBLE PRECISION DEFAULT 1.0;

-- Update existing zones to use the default value
UPDATE "OperationalZone" SET "peso_esforco" = 1.0 WHERE "peso_esforco" IS NULL;

