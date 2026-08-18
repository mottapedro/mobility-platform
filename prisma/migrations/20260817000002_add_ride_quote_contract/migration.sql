-- RideQuote — contrato persistente de precificação (Fase D).
-- Snapshot imutável congelado ANTES da emissão de qualquer RideOffer.
-- Tabela nova + enum novo. Nenhuma coluna alterada em tabelas existentes.

-- 1. Estado da quote.
CREATE TYPE "RideQuoteStatus" AS ENUM ('QUOTED', 'AGREED', 'EXPIRED');

-- 2. Tabela do contrato.
CREATE TABLE "RideQuote" (
  "id" TEXT NOT NULL,
  "rideRequestId" TEXT NOT NULL,
  "pricingDriverId" TEXT NOT NULL,
  "originMLat" DOUBLE PRECISION NOT NULL,
  "originMLng" DOUBLE PRECISION NOT NULL,
  "originMSource" TEXT NOT NULL,
  "distanceMtoAKm" DOUBLE PRECISION NOT NULL,
  "distanceAtoBKm" DOUBLE PRECISION NOT NULL,
  "legCostMtoACents" INTEGER NOT NULL,
  "legPriceAtoBCents" INTEGER NOT NULL,
  "grossFinalCents" INTEGER NOT NULL,
  "revenuePolicyId" TEXT,
  "revenuePolicyVersion" INTEGER,
  "driverReceivableAmountCents" INTEGER NOT NULL,
  "status" "RideQuoteStatus" NOT NULL DEFAULT 'QUOTED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "agreedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RideQuote_pkey" PRIMARY KEY ("id")
);

-- 3. Foreign keys.
ALTER TABLE "RideQuote" ADD CONSTRAINT "RideQuote_rideRequestId_fkey"
  FOREIGN KEY ("rideRequestId") REFERENCES "RideRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RideQuote" ADD CONSTRAINT "RideQuote_pricingDriverId_fkey"
  FOREIGN KEY ("pricingDriverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RideQuote" ADD CONSTRAINT "RideQuote_revenuePolicyId_fkey"
  FOREIGN KEY ("revenuePolicyId") REFERENCES "RevenuePolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Índices.
CREATE INDEX "RideQuote_rideRequestId_idx" ON "RideQuote"("rideRequestId");
CREATE INDEX "RideQuote_pricingDriverId_idx" ON "RideQuote"("pricingDriverId");
CREATE INDEX "RideQuote_revenuePolicyId_idx" ON "RideQuote"("revenuePolicyId");
CREATE INDEX "RideQuote_expiresAt_idx" ON "RideQuote"("expiresAt");
CREATE INDEX "RideQuote_rideRequestId_pricingDriverId_status_idx"
  ON "RideQuote"("rideRequestId", "pricingDriverId", "status");

-- 5. Partial unique — uma única quote viva (QUOTED|AGREED) por (corrida, driver).
--    Predicado imutável; espelha o padrão RideOffer_one_pending_per_ride.
CREATE UNIQUE INDEX "RideQuote_one_active_per_ride_driver"
  ON "RideQuote"("rideRequestId", "pricingDriverId")
  WHERE status = 'QUOTED' OR status = 'AGREED';
