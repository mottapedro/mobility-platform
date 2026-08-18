-- Governed Sequential Dispatch — persistent queue state on RideRequest.
-- Phase 2 of the dispatch refactor: replaces ephemeral re-derivation
-- (deriveLevel scanning RideOffer history) with an authoritative state row.

-- 1. New enum for the matching tier the dispatcher is currently advancing through.
CREATE TYPE "MatchLevel" AS ENUM (
  'REFERRED',
  'NETWORK_L1',
  'NETWORK_L2',
  'NETWORK_L3',
  'REGION',
  'GLOBAL'
);

-- 2. Queue state columns on RideRequest.
ALTER TABLE "RideRequest"
  ADD COLUMN "currentStage"             "MatchLevel",
  ADD COLUMN "excludedDriverIds"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "queueSnapshot"            JSONB,
  ADD COLUMN "currentCandidateDriverId" TEXT,
  ADD COLUMN "lastOfferExpiredAt"       TIMESTAMP(3);

-- 3. Partial unique index — enforces COUNT(PENDING)=1 at the database level
--    so two concurrent dispatchers cannot race-create simultaneous PENDING offers.
--    NOTE: Postgres requires an immutable predicate; status='PENDING' qualifies.
CREATE UNIQUE INDEX "RideOffer_one_pending_per_ride"
  ON "RideOffer" ("rideRequestId")
  WHERE status = 'PENDING';
