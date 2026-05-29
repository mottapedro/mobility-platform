-- Dispatch Stage / MatchLevel separation.
-- Phase 2 introduced an enum named "MatchLevel" purely to persist the
-- dispatcher's runtime stage on RideRequest.currentStage. That created a
-- semantic collision with the application-layer MatchLevel (priority
-- classification). This migration separates the concerns:
--   * Drops the persisted enum "MatchLevel" and column "currentStage".
--   * Adds a dedicated enum "DispatchStage" aligned 1:1 with telemetry stage
--     codes (REFERRAL_DIRECT, REFERRAL_NETWORK, REGION, GLOBAL).
--   * Adds a renamed column "currentDispatchStage" of type DispatchStage.
--
-- Destructive rewrite is safe because Phase 2 (commit ac9d779) is not
-- deployed beyond dev; no production rows depend on currentStage.
ALTER TABLE "RideRequest"
DROP COLUMN IF EXISTS "currentStage";

DROP TYPE IF EXISTS "MatchLevel";

CREATE TYPE "DispatchStage" AS ENUM (
    'REFERRAL_DIRECT',
    'REFERRAL_NETWORK',
    'REGION',
    'GLOBAL'
);

ALTER TABLE "RideRequest"
ADD COLUMN "currentDispatchStage" "DispatchStage";