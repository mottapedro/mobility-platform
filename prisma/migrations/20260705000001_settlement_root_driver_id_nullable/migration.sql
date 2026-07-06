-- Settlement.rootDriverId → nullable
-- Allows settlements where no referral chain exists (new passengers without a rootDriver).
-- SettlementService still enforces rootDriverId at the service layer; this unlocks
-- direct Prisma creation for defensive unit tests of RewardDistributionService.
ALTER TABLE "Settlement" ALTER COLUMN "rootDriverId" DROP NOT NULL;
