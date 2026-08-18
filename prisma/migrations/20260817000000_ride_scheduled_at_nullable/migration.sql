-- RideRequest.scheduledAt: null = IMMEDIATE; future date = SCHEDULED.
-- Existing rows keep their persisted scheduledAt; nothing is backfilled.
ALTER TABLE "RideRequest" ALTER COLUMN "scheduledAt" DROP NOT NULL;