-- Supports authenticated driver offer-book history pagination.
CREATE INDEX "RideOffer_driverId_createdAt_idx"
  ON "RideOffer" ("driverId", "createdAt" DESC);
