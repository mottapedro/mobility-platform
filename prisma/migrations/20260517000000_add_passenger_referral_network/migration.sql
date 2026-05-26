-- AlterTable: add passenger referral network columns
ALTER TABLE "Passenger" ADD COLUMN IF NOT EXISTS "referralCode" TEXT;
ALTER TABLE "Passenger" ADD COLUMN IF NOT EXISTS "publicSlug" TEXT;
ALTER TABLE "Passenger" ADD COLUMN IF NOT EXISTS "referredByPassengerId" TEXT;
ALTER TABLE "Passenger" ADD COLUMN IF NOT EXISTS "networkLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Passenger" ADD COLUMN IF NOT EXISTS "rootPassengerId" TEXT;
ALTER TABLE "Passenger" ADD COLUMN IF NOT EXISTS "lineagePath" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Passenger" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Passenger" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex: unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS "Passenger_referralCode_key" ON "Passenger"("referralCode");
CREATE UNIQUE INDEX IF NOT EXISTS "Passenger_publicSlug_key" ON "Passenger"("publicSlug");

-- AddForeignKey: self-referential (ON DELETE SET NULL prevents cascade issues)
ALTER TABLE "Passenger"
  ADD CONSTRAINT "Passenger_referredByPassengerId_fkey"
  FOREIGN KEY ("referredByPassengerId")
  REFERENCES "Passenger"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
