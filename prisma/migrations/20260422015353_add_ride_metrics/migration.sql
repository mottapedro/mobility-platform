-- AlterTable
ALTER TABLE "RideRequest" ADD COLUMN     "destinationLat" DOUBLE PRECISION,
ADD COLUMN     "destinationLng" DOUBLE PRECISION,
ADD COLUMN     "distanceKm" DOUBLE PRECISION,
ADD COLUMN     "durationMin" INTEGER,
ADD COLUMN     "originLat" DOUBLE PRECISION,
ADD COLUMN     "originLng" DOUBLE PRECISION,
ADD COLUMN     "priceEstimated" DOUBLE PRECISION,
ADD COLUMN     "priceOffered" DOUBLE PRECISION;
