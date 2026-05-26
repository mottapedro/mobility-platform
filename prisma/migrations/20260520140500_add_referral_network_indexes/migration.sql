CREATE INDEX IF NOT EXISTS "Passenger_referredByDriverId_idx"
ON "Passenger"("referredByDriverId");

CREATE INDEX IF NOT EXISTS "DriverReferral_referrerDriverId_level_idx"
ON "DriverReferral"("referrerDriverId", "level");
