ALTER TABLE "Driver"
  ADD COLUMN IF NOT EXISTS "networkLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "referredByDriverId" TEXT,
  ADD COLUMN IF NOT EXISTS "publicSlug" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'Driver_referredByDriverId_fkey'
      AND table_name = 'Driver'
  ) THEN
    ALTER TABLE "Driver"
      ADD CONSTRAINT "Driver_referredByDriverId_fkey"
      FOREIGN KEY ("referredByDriverId") REFERENCES "Driver"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Driver_referredByDriverId_idx" ON "Driver"("referredByDriverId");
CREATE INDEX IF NOT EXISTS "Driver_networkLevel_idx" ON "Driver"("networkLevel");
