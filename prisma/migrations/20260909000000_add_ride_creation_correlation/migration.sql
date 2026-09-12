ALTER TABLE "RideRequest"
ADD COLUMN "creationCorrelationId" TEXT;

CREATE UNIQUE INDEX "RideRequest_creationCorrelationId_key"
ON "RideRequest"("creationCorrelationId");
