-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "referredByDriverId" TEXT;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_referredByDriverId_fkey" FOREIGN KEY ("referredByDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
