-- Model B: Lifecycle Separation Migration
-- Generated: 2026-06-09
-- REVIEW BEFORE APPLYING

-- ============================================================================
-- SAFE: New enum for dispatch stages (orthogonal to ride status)
-- ============================================================================
CREATE TYPE "DispatchCycleStage" AS ENUM ('OWNER_DISPATCH', 'NETWORK_DISPATCH', 'OWNER_RECOVERY');

-- ============================================================================
-- CRITICAL: RideOfferStatus enum migration
-- Pattern: create new → migrate data → rename → drop old
-- ⚠️  Will FAIL if existing rows contain: PENDING, REJECTED, EXPIRED
-- ============================================================================
BEGIN;
CREATE TYPE "RideOfferStatus_new" AS ENUM ('OFFER_CREATED', 'OFFER_VIEWED', 'OFFER_ACCEPTED', 'OFFER_DECLINED', 'OFFER_EXPIRED', 'OFFER_CANCELLED');
ALTER TABLE "public"."RideOffer" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "RideOffer" ALTER COLUMN "status" TYPE "RideOfferStatus_new" USING ("status"::text::"RideOfferStatus_new");
ALTER TYPE "RideOfferStatus" RENAME TO "RideOfferStatus_old";
ALTER TYPE "RideOfferStatus_new" RENAME TO "RideOfferStatus";
DROP TYPE "public"."RideOfferStatus_old";
ALTER TABLE "RideOffer" ALTER COLUMN "status" SET DEFAULT 'OFFER_CREATED';
COMMIT;

-- ============================================================================
-- CRITICAL: RideStatus enum migration
-- ⚠️  Will FAIL if existing rows contain: PAID, IN_PROGRESS, PENDING, MATCHING, WAITING_REFERRAL
-- ============================================================================
BEGIN;
CREATE TYPE "RideStatus_new" AS ENUM ('REQUESTED', 'ACCEPTED', 'STARTED', 'COMPLETED', 'CANCELLED', 'EXPIRED');
ALTER TABLE "public"."RideRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "RideRequest" ALTER COLUMN "status" TYPE "RideStatus_new" USING ("status"::text::"RideStatus_new");
ALTER TYPE "RideStatus" RENAME TO "RideStatus_old";
ALTER TYPE "RideStatus_new" RENAME TO "RideStatus";
DROP TYPE "public"."RideStatus_old";
ALTER TABLE "RideRequest" ALTER COLUMN "status" SET DEFAULT 'REQUESTED';
COMMIT;

-- ============================================================================
-- SAFE: Add audit/governance columns
-- ============================================================================
ALTER TABLE "ReferralRelationship" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "ReferralRelationship" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "ReferralRelationship" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "RevenueSplit" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "RevenueSplit" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "RevenueSplit" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "RideOffer" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "RideOffer" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "RideOffer" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "RideOffer" ADD COLUMN "updatedBy" TEXT;
ALTER TABLE "RideOffer" ALTER COLUMN "status" SET DEFAULT 'OFFER_CREATED';

ALTER TABLE "RideRequest" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "RideRequest" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "RideRequest" ADD COLUMN "dispatchStage" "DispatchCycleStage";
ALTER TABLE "RideRequest" ADD COLUMN "flowType" "ReferralFlowType";
ALTER TABLE "RideRequest" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "RideRequest" ADD COLUMN "operationalOwnerId" TEXT;
ALTER TABLE "RideRequest" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "RideRequest" ADD COLUMN "updatedBy" TEXT;
ALTER TABLE "RideRequest" ALTER COLUMN "status" SET DEFAULT 'REQUESTED';

ALTER TABLE "Settlement" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "Settlement" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- ============================================================================
-- SAFE: Operational zones (new feature)
-- ============================================================================
CREATE TABLE "OperationalZone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "OperationalZone_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DriverOperationalZone" (
    "driverId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "DriverOperationalZone_pkey" PRIMARY KEY ("driverId","zoneId")
);

CREATE UNIQUE INDEX "OperationalZone_name_key" ON "OperationalZone"("name");
CREATE UNIQUE INDEX "RideRequest_idempotencyKey_key" ON "RideRequest"("idempotencyKey");

ALTER TABLE "DriverOperationalZone" ADD CONSTRAINT "DriverOperationalZone_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DriverOperationalZone" ADD CONSTRAINT "DriverOperationalZone_zoneId_fkey"
  FOREIGN KEY ("zoneId") REFERENCES "OperationalZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
