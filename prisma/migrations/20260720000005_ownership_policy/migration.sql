-- Migration: ResolutionStrategy enum + OwnershipPolicy model + OwnershipSnapshot FK columns (ADD ONLY)
-- ADR-004 — Ownership Resolution, Step 2

-- Enum: estratégia de resolução de ownership
CREATE TYPE "ResolutionStrategy" AS ENUM (
  'PASSENGER_ROOTDRIVER_DIRECT',
  'REFERRAL_CHAIN',
  'CORPORATE_ACCOUNT',
  'FRANCHISE_OWNER',
  'MARKETPLACE_PARTNER'
);

-- Tabela de políticas de ownership — desacopla algoritmo do código
CREATE TABLE "OwnershipPolicy" (
  "id"                 TEXT                  NOT NULL,
  "code"               TEXT                  NOT NULL,
  "name"               TEXT                  NOT NULL,
  "version"            INTEGER               NOT NULL DEFAULT 1,
  "resolutionStrategy" "ResolutionStrategy"  NOT NULL,
  "ownerType"          "OwnerType"           NOT NULL,
  "effectiveFrom"      TIMESTAMP(3),
  "effectiveUntil"     TIMESTAMP(3),
  "isActive"           BOOLEAN               NOT NULL DEFAULT true,
  "createdAt"          TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OwnershipPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OwnershipPolicy_code_version_key" ON "OwnershipPolicy"("code", "version");
CREATE INDEX "OwnershipPolicy_isActive_effectiveFrom_effectiveUntil_idx"
  ON "OwnershipPolicy"("isActive", "effectiveFrom", "effectiveUntil");

-- Adiciona FK de auditabilidade ao OwnershipSnapshot
-- null = snapshot criado antes da ADR-004 Step 2 (período de transição)
ALTER TABLE "OwnershipSnapshot"
  ADD COLUMN "ownershipPolicyId"      TEXT,
  ADD COLUMN "ownershipPolicyVersion" INTEGER;

CREATE INDEX "OwnershipSnapshot_ownershipPolicyId_idx"
  ON "OwnershipSnapshot"("ownershipPolicyId");

ALTER TABLE "OwnershipSnapshot"
  ADD CONSTRAINT "OwnershipSnapshot_ownershipPolicyId_fkey"
  FOREIGN KEY ("ownershipPolicyId")
  REFERENCES "OwnershipPolicy"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
