CREATE TYPE "DemandRevisionState" AS ENUM ('CURRENT', 'SUPERSEDED');

CREATE TYPE "DispatchRoundState" AS ENUM ('ACTIVE', 'MATCHED', 'EXHAUSTED', 'SUPERSEDED', 'ABORTED');

CREATE TYPE "DispatchRoundTerminalReason" AS ENUM ('ACCEPTED', 'NETWORK_EXHAUSTED', 'OPERATIONAL_CUTOFF', 'SUPERSEDED', 'ABORTED');

CREATE TYPE "DispatchCandidateAccountingDisposition" AS ENUM ('OPEN', 'CONSUMED', 'VALID_EXCLUSION', 'UNAVAILABLE_UNDER_CONTRACT', 'FULFILLED');

CREATE TYPE "DispatchCandidateConsumptionReason" AS ENUM ('REJECTED', 'EXPIRED');

CREATE TYPE "DispatchCandidateOfferObservation" AS ENUM ('NONE', 'PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');

CREATE TABLE "DemandRevision" (
    "id" TEXT NOT NULL,
    "rideRequestId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "state" "DemandRevisionState" NOT NULL DEFAULT 'CURRENT',
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "originPlaceId" TEXT,
    "destinationPlaceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "DemandRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DispatchRound" (
    "id" TEXT NOT NULL,
    "demandRevisionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "state" "DispatchRoundState" NOT NULL DEFAULT 'ACTIVE',
    "candidateUniverseBoundaryAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "terminalReason" "DispatchRoundTerminalReason",
    "fenceVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DispatchRound_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DispatchRoundCandidate" (
    "id" TEXT NOT NULL,
    "dispatchRoundId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "eligibleAtBoundary" TIMESTAMP(3) NOT NULL,
    "boundarySource" TEXT NOT NULL,
    "accountingDisposition" "DispatchCandidateAccountingDisposition" NOT NULL DEFAULT 'OPEN',
    "consumptionReason" "DispatchCandidateConsumptionReason",
    "exclusionReason" TEXT,
    "offerObservation" "DispatchCandidateOfferObservation" NOT NULL DEFAULT 'NONE',
    "dispositionAt" TIMESTAMP(3),
    "evidenceVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchRoundCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DispatchRoundExhaustionSummary" (
    "id" TEXT NOT NULL,
    "dispatchRoundId" TEXT NOT NULL,
    "evidenceVersion" INTEGER NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "boundaryAt" TIMESTAMP(3) NOT NULL,
    "eligibleCount" INTEGER NOT NULL,
    "consumedCount" INTEGER NOT NULL,
    "excludedCount" INTEGER NOT NULL,
    "remainingCount" INTEGER NOT NULL,
    "evidenceHash" TEXT,
    "derivedSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchRoundExhaustionSummary_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RideOffer" ADD COLUMN "dispatchRoundId" TEXT;

CREATE UNIQUE INDEX "DemandRevision_rideRequestId_sequence_key" ON "DemandRevision"("rideRequestId", "sequence");
CREATE INDEX "DemandRevision_rideRequestId_state_idx" ON "DemandRevision"("rideRequestId", "state");
CREATE UNIQUE INDEX "DispatchRound_demandRevisionId_sequence_key" ON "DispatchRound"("demandRevisionId", "sequence");
CREATE INDEX "DispatchRound_demandRevisionId_state_idx" ON "DispatchRound"("demandRevisionId", "state");
CREATE UNIQUE INDEX "DispatchRoundCandidate_dispatchRoundId_driverId_key" ON "DispatchRoundCandidate"("dispatchRoundId", "driverId");
CREATE INDEX "DispatchRoundCandidate_dispatchRoundId_accountingDisposition_idx" ON "DispatchRoundCandidate"("dispatchRoundId", "accountingDisposition");
CREATE INDEX "DispatchRoundCandidate_driverId_idx" ON "DispatchRoundCandidate"("driverId");
CREATE UNIQUE INDEX "DispatchRoundExhaustionSummary_dispatchRoundId_key" ON "DispatchRoundExhaustionSummary"("dispatchRoundId");
CREATE UNIQUE INDEX "RideOffer_dispatchRoundId_driverId_key" ON "RideOffer"("dispatchRoundId", "driverId");

CREATE UNIQUE INDEX "DemandRevision_one_current_per_request"
ON "DemandRevision"("rideRequestId")
WHERE "state" = 'CURRENT';

CREATE UNIQUE INDEX "DispatchRound_one_active_per_revision"
ON "DispatchRound"("demandRevisionId")
WHERE "state" = 'ACTIVE';

ALTER TABLE "DemandRevision"
  ADD CONSTRAINT "DemandRevision_sequence_positive_check" CHECK ("sequence" > 0);

ALTER TABLE "DispatchRound"
  ADD CONSTRAINT "DispatchRound_sequence_positive_check" CHECK ("sequence" > 0),
  ADD CONSTRAINT "DispatchRound_fenceVersion_nonnegative_check" CHECK ("fenceVersion" >= 0),
  ADD CONSTRAINT "DispatchRound_lifecycle_timestamp_check" CHECK (
    ("state" = 'ACTIVE' AND "completedAt" IS NULL AND "terminalReason" IS NULL)
    OR
    ("state" IN ('MATCHED', 'EXHAUSTED', 'SUPERSEDED', 'ABORTED') AND "completedAt" IS NOT NULL)
  );

ALTER TABLE "DemandRevision"
  ADD CONSTRAINT "DemandRevision_rideRequestId_fkey"
  FOREIGN KEY ("rideRequestId") REFERENCES "RideRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DispatchRound"
  ADD CONSTRAINT "DispatchRound_demandRevisionId_fkey"
  FOREIGN KEY ("demandRevisionId") REFERENCES "DemandRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DispatchRoundCandidate"
  ADD CONSTRAINT "DispatchRoundCandidate_dispatchRoundId_fkey"
  FOREIGN KEY ("dispatchRoundId") REFERENCES "DispatchRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "DispatchRoundCandidate_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DispatchRoundExhaustionSummary"
  ADD CONSTRAINT "DispatchRoundExhaustionSummary_dispatchRoundId_fkey"
  FOREIGN KEY ("dispatchRoundId") REFERENCES "DispatchRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RideOffer"
  ADD CONSTRAINT "RideOffer_dispatchRoundId_fkey"
  FOREIGN KEY ("dispatchRoundId") REFERENCES "DispatchRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "validate_RideOffer_request_round_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_ride_request_id TEXT;
BEGIN
  IF NEW."dispatchRoundId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT dr."rideRequestId"
    INTO expected_ride_request_id
    FROM "DispatchRound" r
    JOIN "DemandRevision" dr ON dr."id" = r."demandRevisionId"
   WHERE r."id" = NEW."dispatchRoundId";

  IF expected_ride_request_id IS NULL THEN
    RAISE EXCEPTION 'RideOffer dispatch round has no resolvable RideRequest';
  END IF;

  IF NEW."rideRequestId" <> expected_ride_request_id THEN
    RAISE EXCEPTION 'RideOffer rideRequestId does not match dispatch round revision';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "RideOffer_request_round_consistency_trigger"
BEFORE INSERT OR UPDATE OF "rideRequestId", "dispatchRoundId"
ON "RideOffer"
FOR EACH ROW
EXECUTE FUNCTION "validate_RideOffer_request_round_consistency"();
