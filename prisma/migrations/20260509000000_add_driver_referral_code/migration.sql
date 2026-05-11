ALTER TABLE "Driver"
ADD COLUMN "referralCode" TEXT;

UPDATE "Driver"
SET "referralCode" = lower(replace("id", '-', ''))
WHERE "referralCode" IS NULL;

ALTER TABLE "Driver"
ALTER COLUMN "referralCode" SET NOT NULL;

CREATE UNIQUE INDEX "Driver_referralCode_key"
ON "Driver"("referralCode");