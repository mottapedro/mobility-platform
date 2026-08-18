-- Migration: RevenuePolicy entity + Settlement FK (ADD ONLY)
-- ADR-002 v1.1 — Settlement V2 Step 1

-- Enum: base de cálculo da política de distribuição
CREATE TYPE "RevenuePolicyBaseType" AS ENUM ('OPERATIONAL_REVENUE');

-- Entidade RevenuePolicy
CREATE TABLE "RevenuePolicy" (
  "id"             TEXT        NOT NULL,
  "code"           TEXT        NOT NULL,
  "name"           TEXT        NOT NULL,
  "version"        INTEGER     NOT NULL DEFAULT 1,
  "baseType"       "RevenuePolicyBaseType" NOT NULL DEFAULT 'OPERATIONAL_REVENUE',
  "rootDriverBps"  INTEGER     NOT NULL,
  "effectiveFrom"  TIMESTAMP(3),
  "effectiveUntil" TIMESTAMP(3),
  "isActive"       BOOLEAN     NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RevenuePolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RevenuePolicy_code_key"     ON "RevenuePolicy"("code");
CREATE UNIQUE INDEX "RevenuePolicy_code_version_key" ON "RevenuePolicy"("code", "version");
CREATE INDEX "RevenuePolicy_isActive_effectiveFrom_effectiveUntil_idx"
  ON "RevenuePolicy"("isActive", "effectiveFrom", "effectiveUntil");

-- Settlement: adicionar FK para RevenuePolicy (ADD ONLY — nullable)
ALTER TABLE "Settlement"
  ADD COLUMN IF NOT EXISTS "revenuePolicyId"      TEXT,
  ADD COLUMN IF NOT EXISTS "revenuePolicyVersion" INTEGER;

CREATE INDEX IF NOT EXISTS "Settlement_revenuePolicyId_idx"
  ON "Settlement"("revenuePolicyId");

ALTER TABLE "Settlement"
  ADD CONSTRAINT "Settlement_revenuePolicyId_fkey"
  FOREIGN KEY ("revenuePolicyId")
  REFERENCES "RevenuePolicy"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
