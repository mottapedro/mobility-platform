-- ADD ONLY — RideRequest.originPlaceId / destinationPlaceId.
-- providerPlaceId (Google Place Details New) is validated server-side.
-- Existing rides keep NULL; nothing is backfilled.
ALTER TABLE "RideRequest"
  ADD COLUMN "originPlaceId"       TEXT,
  ADD COLUMN "destinationPlaceId"  TEXT;