-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('DRIVER', 'PASSENGER');

-- CreateEnum
CREATE TYPE "ExperienceLevel" AS ENUM ('INICIANTE', 'INTERMEDIARIO', 'PROFISSIONAL', 'ELITE');

-- CreateEnum
CREATE TYPE "VehicleCategory" AS ENUM ('CONFORTO', 'EXECUTIVO');

-- CreateEnum
CREATE TYPE "Region" AS ENUM ('ZN', 'ZS', 'ZO', 'BAIXADA', 'INTER');

-- CreateEnum
CREATE TYPE "RideStatus" AS ENUM ('PENDING', 'MATCHING', 'WAITING_DRIVER', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RideOfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "experienceLevel" "ExperienceLevel" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Passenger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "referredByDriverId" TEXT,

    CONSTRAINT "Passenger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "category" "VehicleCategory" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverRegion" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "region" "Region" NOT NULL,

    CONSTRAINT "DriverRegion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverAvailability" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,

    CONSTRAINT "DriverAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RideRequest" (
    "id" TEXT NOT NULL,
    "passengerId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "RideStatus" NOT NULL DEFAULT 'PENDING',
    "selectedDriverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RideRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RideOffer" (
    "id" TEXT NOT NULL,
    "rideRequestId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "status" "RideOfferStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RideOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_userId_key" ON "Driver"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Passenger_userId_key" ON "Passenger"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_plate_key" ON "Vehicle"("plate");

-- CreateIndex
CREATE UNIQUE INDEX "DriverRegion_driverId_region_key" ON "DriverRegion"("driverId", "region");

-- CreateIndex
CREATE INDEX "RideRequest_scheduledAt_idx" ON "RideRequest"("scheduledAt");

-- CreateIndex
CREATE INDEX "RideOffer_driverId_status_idx" ON "RideOffer"("driverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RideOffer_rideRequestId_driverId_key" ON "RideOffer"("rideRequestId", "driverId");

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passenger" ADD CONSTRAINT "Passenger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passenger" ADD CONSTRAINT "Passenger_referredByDriverId_fkey" FOREIGN KEY ("referredByDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverRegion" ADD CONSTRAINT "DriverRegion_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverAvailability" ADD CONSTRAINT "DriverAvailability_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RideRequest" ADD CONSTRAINT "RideRequest_passengerId_fkey" FOREIGN KEY ("passengerId") REFERENCES "Passenger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RideRequest" ADD CONSTRAINT "RideRequest_selectedDriverId_fkey" FOREIGN KEY ("selectedDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RideOffer" ADD CONSTRAINT "RideOffer_rideRequestId_fkey" FOREIGN KEY ("rideRequestId") REFERENCES "RideRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RideOffer" ADD CONSTRAINT "RideOffer_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
