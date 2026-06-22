-- Migration: Add OperationalZone and DriverOperationalZone tables

CREATE TABLE "OperationalZone" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OperationalZone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OperationalZone_name_key" ON "OperationalZone"("name");

CREATE TABLE "DriverOperationalZone" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "driverId" TEXT NOT NULL,
  "zoneId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DriverOperationalZone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DriverOperationalZone_driverId_zoneId_key" ON "DriverOperationalZone"("driverId", "zoneId");
CREATE INDEX "DriverOperationalZone_zoneId_idx" ON "DriverOperationalZone"("zoneId");

ALTER TABLE "DriverOperationalZone" ADD CONSTRAINT "DriverOperationalZone_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DriverOperationalZone" ADD CONSTRAINT "DriverOperationalZone_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "OperationalZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;