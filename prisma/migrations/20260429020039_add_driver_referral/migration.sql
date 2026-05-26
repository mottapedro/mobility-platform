/*
  Warnings:

  - You are about to drop the column `referredByDriverId` on the `Driver` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Driver" DROP CONSTRAINT "Driver_referredByDriverId_fkey";

-- AlterTable
ALTER TABLE "Driver" DROP COLUMN "referredByDriverId";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordHash" TEXT;

-- CreateTable
CREATE TABLE "DriverReferral" (
    "id" TEXT NOT NULL,
    "referrerDriverId" TEXT NOT NULL,
    "referredDriverId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverReferral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverReferral_referrerDriverId_referredDriverId_key" ON "DriverReferral"("referrerDriverId", "referredDriverId");

-- AddForeignKey
ALTER TABLE "DriverReferral" ADD CONSTRAINT "DriverReferral_referrerDriverId_fkey" FOREIGN KEY ("referrerDriverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverReferral" ADD CONSTRAINT "DriverReferral_referredDriverId_fkey" FOREIGN KEY ("referredDriverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
