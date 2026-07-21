-- Migration: OwnerType enum + OwnershipSnapshot model (ADD ONLY)
-- ADR-004 — Ownership Resolution & Ownership Snapshot, Step 1

-- Enum: tipo do proprietário econômico da corrida
CREATE TYPE "OwnerType" AS ENUM ('ROOT_DRIVER', 'CORPORATE', 'FRANCHISE', 'NONE');

-- Snapshot imutável de ownership — criado quando a corrida é criada
CREATE TABLE "OwnershipSnapshot" (
  "id"                         TEXT         NOT NULL,
  "rideId"                     TEXT         NOT NULL,
  "ownerId"                    TEXT,
  "ownerType"                  "OwnerType"  NOT NULL DEFAULT 'NONE',
  "ownershipPolicyCode"        TEXT         NOT NULL DEFAULT 'PASSENGER_ROOTDRIVER_DIRECT',
  "ownershipResolutionVersion" INTEGER      NOT NULL DEFAULT 1,
  "resolutionSource"           TEXT         NOT NULL,
  "resolvedAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OwnershipSnapshot_pkey"   PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OwnershipSnapshot_rideId_key" ON "OwnershipSnapshot"("rideId");
CREATE INDEX "OwnershipSnapshot_ownerId_idx"        ON "OwnershipSnapshot"("ownerId");

ALTER TABLE "OwnershipSnapshot"
  ADD CONSTRAINT "OwnershipSnapshot_rideId_fkey"
  FOREIGN KEY ("rideId")
  REFERENCES "RideRequest"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
