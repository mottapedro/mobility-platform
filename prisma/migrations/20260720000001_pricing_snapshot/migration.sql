-- ADR-001 §5 — Pricing Snapshot
-- ADD ONLY migration: new nullable columns on RideRequest.
-- Existing rides retain NULL for all new fields (no data loss, no recalculation).
-- Never drop or alter these columns after data is persisted.

ALTER TABLE "RideRequest"
  ADD COLUMN IF NOT EXISTS "baseCOE"         DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "zoneMultiplier"  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "liquidityMargin" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "liquidityAmount" DOUBLE PRECISION;
