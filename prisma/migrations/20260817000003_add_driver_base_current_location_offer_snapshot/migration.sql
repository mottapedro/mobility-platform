-- Fase E — base operacional do motorista (origem M fixa para precificação).
CREATE TABLE "DriverOperationalBase" (
    "id"               TEXT         NOT NULL,
    "driverId"         TEXT         NOT NULL,
    "formattedAddress" TEXT         NOT NULL,
    "providerPlaceId"  TEXT,
    "latitude"         DOUBLE PRECISION NOT NULL,
    "longitude"        DOUBLE PRECISION NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DriverOperationalBase_pkey" PRIMARY KEY ("id")
);

-- Latitude: entre -90 e 90.
ALTER TABLE "DriverOperationalBase" ADD CONSTRAINT "DriverOperationalBase_latitude_check" CHECK ("latitude" >= -90 AND "latitude" <= 90);
-- Longitude: entre -180 e 180.
ALTER TABLE "DriverOperationalBase" ADD CONSTRAINT "DriverOperationalBase_longitude_check" CHECK ("longitude" >= -180 AND "longitude" <= 180);

CREATE UNIQUE INDEX "DriverOperationalBase_driverId_key" ON "DriverOperationalBase"("driverId");

-- FK: base pertence a um driver; driver deletado remove a base.
ALTER TABLE "DriverOperationalBase" ADD CONSTRAINT "DriverOperationalBase_driverId_fkey"
    FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "DriverOperationalBase_driverId_idx" ON "DriverOperationalBase"("driverId");

-- Fase E — posição global corrente do motorista (upsert por driver).
CREATE TABLE "DriverCurrentLocation" (
    "id"         TEXT         NOT NULL,
    "driverId"   TEXT         NOT NULL,
    "latitude"   DOUBLE PRECISION NOT NULL,
    "longitude"  DOUBLE PRECISION NOT NULL,
    "accuracy"   DOUBLE PRECISION,
    "odometer"   INTEGER,
    "speed"      DOUBLE PRECISION,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DriverCurrentLocation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DriverCurrentLocation" ADD CONSTRAINT "DriverCurrentLocation_latitude_check" CHECK ("latitude" >= -90 AND "latitude" <= 90);
ALTER TABLE "DriverCurrentLocation" ADD CONSTRAINT "DriverCurrentLocation_longitude_check" CHECK ("longitude" >= -180 AND "longitude" <= 180);

CREATE UNIQUE INDEX "DriverCurrentLocation_driverId_key" ON "DriverCurrentLocation"("driverId");

ALTER TABLE "DriverCurrentLocation" ADD CONSTRAINT "DriverCurrentLocation_driverId_fkey"
    FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "DriverCurrentLocation_driverId_idx" ON "DriverCurrentLocation"("driverId");

-- Fase E — snapshot da oferta. Copiado da RideQuote na primeira oferta;
-- recalculado apenas para a perna M→A no redispatch (M2/M3), sem tocar na
-- precificação do passageiro (RideQuote/gross permanecem intactos).
ALTER TABLE "RideOffer"
    ADD COLUMN "driverToPickupDistanceKm"    DOUBLE PRECISION,
    ADD COLUMN "rideDistanceKm"              DOUBLE PRECISION,
    ADD COLUMN "driverReceivableAmountCents" INTEGER;
