-- AlterEnum
ALTER TYPE "DomainEventType" ADD VALUE 'DRIVER_REFERRED';

-- DropForeignKey
ALTER TABLE "DriverSkill" DROP CONSTRAINT "DriverSkill_driver_fkey";

-- DropForeignKey
ALTER TABLE "DriverSkill" DROP CONSTRAINT "DriverSkill_skill_fkey";

-- DropForeignKey
ALTER TABLE "ReferralRelationship" DROP CONSTRAINT "ReferralRelationship_inviterDriver_fkey";

-- DropForeignKey
ALTER TABLE "ReferralRelationship" DROP CONSTRAINT "ReferralRelationship_rootDriver_fkey";

-- DropForeignKey
ALTER TABLE "RevenueSplit" DROP CONSTRAINT "RevenueSplit_settlementId_fkey";

-- DropIndex
DROP INDEX "Driver_networkLevel_idx";

-- DropIndex
DROP INDEX "Driver_referredByDriverId_idx";

-- DropIndex
DROP INDEX "Passenger_referredByDriverId_idx";

-- AlterTable
ALTER TABLE "Driver" ALTER COLUMN "regions" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Passenger" ALTER COLUMN "referralCode" DROP NOT NULL,
ALTER COLUMN "publicSlug" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PaymentIntent" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "ReferralRelationship" ADD CONSTRAINT "ReferralRelationship_rootDriverId_fkey" FOREIGN KEY ("rootDriverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralRelationship" ADD CONSTRAINT "ReferralRelationship_inviterDriverId_fkey" FOREIGN KEY ("inviterDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverSkill" ADD CONSTRAINT "DriverSkill_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverSkill" ADD CONSTRAINT "DriverSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueSplit" ADD CONSTRAINT "RevenueSplit_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "DriverSkill_driver_skill_unique" RENAME TO "DriverSkill_driverId_skillId_key";

-- RenameIndex
ALTER INDEX "DriverSkill_skill_idx" RENAME TO "DriverSkill_skillId_idx";

-- RenameIndex
ALTER INDEX "Invite_owner_idx" RENAME TO "Invite_ownerActorType_ownerId_idx";

-- RenameIndex
ALTER INDEX "ReferralRelationship_invited_unique" RENAME TO "ReferralRelationship_invitedActorType_invitedId_key";

-- RenameIndex
ALTER INDEX "ReferralRelationship_inviter_idx" RENAME TO "ReferralRelationship_inviterActorType_inviterId_idx";

-- RenameIndex
ALTER INDEX "ReferralRelationship_rootDriver_idx" RENAME TO "ReferralRelationship_rootDriverId_idx";
