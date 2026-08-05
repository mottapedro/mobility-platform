-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('DRIVER', 'PASSENGER');

-- CreateEnum
CREATE TYPE "ExperienceLevel" AS ENUM ('INICIANTE', 'INTERMEDIARIO', 'PROFISSIONAL', 'ELITE');

-- CreateEnum
CREATE TYPE "VehicleCategory" AS ENUM ('CONFORTO', 'EXECUTIVO');

-- CreateEnum
CREATE TYPE "Region" AS ENUM ('ZN', 'ZS', 'ZO', 'BAIXADA', 'INTER');

-- CreateEnum
CREATE TYPE "RideStatus" AS ENUM ('PENDING', 'MATCHING', 'WAITING_DRIVER', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'WAITING_REFERRAL', 'WAITING_PARTNER', 'WAITING_GENERAL', 'PAID');

-- CreateEnum
CREATE TYPE "RideOfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'PAID');

-- CreateEnum
CREATE TYPE "DispatchStage" AS ENUM ('REFERRAL_DIRECT', 'REFERRAL_NETWORK', 'REGION', 'GLOBAL', 'OWNER_DISPATCH', 'NETWORK_DISPATCH', 'OWNER_RECOVERY');

-- CreateEnum
CREATE TYPE "ReferralFlowType" AS ENUM ('DRIVER_TO_DRIVER', 'DRIVER_TO_PASSENGER', 'PASSENGER_TO_PASSENGER');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('DRIVER', 'PASSENGER');

-- CreateEnum
CREATE TYPE "DriverSkillCode" AS ENUM ('COLECIONADOR', 'EXECUTIVO', 'TRANSPORTE_ASSISTIDO', 'AEROPORTO', 'LONG_DISTANCE', 'PREMIUM', 'VIP');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PIX');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SplitBeneficiaryType" AS ENUM ('DRIVER', 'PLATFORM', 'ROOT_DRIVER');

-- CreateEnum
CREATE TYPE "DomainEventType" AS ENUM ('PAYMENT_INTENT_CREATED', 'PIX_QRCODE_GENERATED', 'PAYMENT_CONFIRMED', 'PAYMENT_FAILED', 'RIDE_SETTLED', 'REWARD_DISTRIBUTED', 'OFFER_CREATED', 'RIDE_FINALIZED', 'SETTLEMENT_CONFIRMED', 'LINEAGE_RESOLVED', 'SKILL_ASSIGNED', 'DRIVER_REFERRED', 'TRIP_EXECUTION_STARTED');

-- CreateEnum
CREATE TYPE "RevenuePolicyBaseType" AS ENUM ('OPERATIONAL_REVENUE');

-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('ROOT_DRIVER', 'CORPORATE', 'FRANCHISE', 'NONE');

-- CreateEnum
CREATE TYPE "ResolutionStrategy" AS ENUM ('PASSENGER_ROOTDRIVER_DIRECT', 'REFERRAL_CHAIN', 'CORPORATE_ACCOUNT', 'FRANCHISE_OWNER', 'MARKETPLACE_PARTNER');

-- CreateEnum
CREATE TYPE "OwnershipType" AS ENUM ('ROOT_DRIVER', 'INHERITED_DRIVER', 'DIRECT_PASSENGER', 'INHERITED_PASSENGER', 'LATERAL');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "passwordHash" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "experienceLevel" "ExperienceLevel" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referralCode" TEXT NOT NULL,
    "networkLevel" INTEGER NOT NULL DEFAULT 0,
    "referredByDriverId" TEXT,
    "publicSlug" TEXT,
    "regions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Passenger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "referredByDriverId" TEXT,
    "referralCode" TEXT,
    "publicSlug" TEXT,
    "referredByPassengerId" TEXT,
    "networkLevel" INTEGER NOT NULL DEFAULT 0,
    "rootPassengerId" TEXT,
    "lineagePath" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rootDriverId" TEXT,

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
CREATE TABLE "DriverAvailability" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,

    CONSTRAINT "DriverAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalZone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "peso_esforco" DOUBLE PRECISION DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverOperationalZone" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverOperationalZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RideRequest" (
    "id" TEXT NOT NULL,
    "passengerId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "operationalCutoffAt" TIMESTAMP(3),
    "status" "RideStatus" NOT NULL DEFAULT 'PENDING',
    "selectedDriverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "destinationLat" DOUBLE PRECISION,
    "destinationLng" DOUBLE PRECISION,
    "distanceKm" DOUBLE PRECISION,
    "durationMin" INTEGER,
    "originLat" DOUBLE PRECISION,
    "originLng" DOUBLE PRECISION,
    "priceEstimated" DOUBLE PRECISION,
    "priceOffered" DOUBLE PRECISION,
    "context" JSONB,
    "rootDriverId" TEXT,
    "currentDispatchStage" "DispatchStage",
    "excludedDriverIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "queueSnapshot" JSONB,
    "currentCandidateDriverId" TEXT,
    "lastOfferExpiredAt" TIMESTAMP(3),
    "baseCOE" DOUBLE PRECISION,
    "zoneMultiplier" DOUBLE PRECISION,
    "liquidityMargin" DOUBLE PRECISION,
    "liquidityAmount" DOUBLE PRECISION,
    "baseFare" DOUBLE PRECISION,
    "driverNetAmount" DOUBLE PRECISION,
    "platformFee" DOUBLE PRECISION,
    "pricingVersion" TEXT,
    "navigationStartedAt" TIMESTAMP(3),
    "pickupArrivedAt" TIMESTAMP(3),
    "boardingAt" TIMESTAMP(3),
    "tripStartedAt" TIMESTAMP(3),
    "destinationArrivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RideRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverReferral" (
    "id" TEXT NOT NULL,
    "referrerDriverId" TEXT NOT NULL,
    "referredDriverId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "isDirect" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriverReferral_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "ReferralRelationship" (
    "id" TEXT NOT NULL,
    "flowType" "ReferralFlowType" NOT NULL,
    "inviterActorType" "ActorType" NOT NULL,
    "inviterId" TEXT NOT NULL,
    "invitedActorType" "ActorType" NOT NULL,
    "invitedId" TEXT NOT NULL,
    "rootDriverId" TEXT NOT NULL,
    "inviterDriverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "code" "DriverSkillCode" NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverSkill" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "DriverSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenuePolicy" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "baseType" "RevenuePolicyBaseType" NOT NULL DEFAULT 'OPERATIONAL_REVENUE',
    "rootDriverBps" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveUntil" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenuePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnershipPolicy" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "resolutionStrategy" "ResolutionStrategy" NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveUntil" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnershipPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnershipSnapshot" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "ownerId" TEXT,
    "ownerType" "OwnerType" NOT NULL DEFAULT 'NONE',
    "ownershipPolicyCode" TEXT NOT NULL DEFAULT 'PASSENGER_ROOTDRIVER_DIRECT',
    "ownershipPolicyId" TEXT,
    "ownershipPolicyVersion" INTEGER,
    "ownershipResolutionVersion" INTEGER NOT NULL DEFAULT 1,
    "resolutionSource" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnershipSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "rideRequestId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'PIX',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "externalId" TEXT,
    "qrCode" TEXT,
    "qrCodeImage" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "rideRequestId" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "driverCents" INTEGER NOT NULL,
    "platformCents" INTEGER NOT NULL,
    "rootDriverCents" INTEGER NOT NULL,
    "rootDriverId" TEXT,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revenuePolicyId" TEXT,
    "revenuePolicyVersion" INTEGER,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueSplit" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "beneficiaryType" "SplitBeneficiaryType" NOT NULL,
    "beneficiaryDriverId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "percentBps" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueSplit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverLocationPing" (
    "id" TEXT NOT NULL,
    "rideRequestId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'LIVE',

    CONSTRAINT "DriverLocationPing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainEvent" (
    "id" TEXT NOT NULL,
    "type" "DomainEventType" NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "token" TEXT,
    "ownerActorType" "ActorType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "expectedFlowType" "ReferralFlowType" NOT NULL,
    "expectedActorType" "ActorType" NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "consumedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_userId_key" ON "Driver"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_referralCode_key" ON "Driver"("referralCode");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_publicSlug_key" ON "Driver"("publicSlug");

-- CreateIndex
CREATE UNIQUE INDEX "Passenger_userId_key" ON "Passenger"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Passenger_referralCode_key" ON "Passenger"("referralCode");

-- CreateIndex
CREATE UNIQUE INDEX "Passenger_publicSlug_key" ON "Passenger"("publicSlug");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_plate_key" ON "Vehicle"("plate");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalZone_name_key" ON "OperationalZone"("name");

-- CreateIndex
CREATE INDEX "DriverOperationalZone_zoneId_idx" ON "DriverOperationalZone"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverOperationalZone_driverId_zoneId_key" ON "DriverOperationalZone"("driverId", "zoneId");

-- CreateIndex
CREATE INDEX "RideRequest_scheduledAt_idx" ON "RideRequest"("scheduledAt");

-- CreateIndex
CREATE INDEX "DriverReferral_referredDriverId_idx" ON "DriverReferral"("referredDriverId");

-- CreateIndex
CREATE INDEX "DriverReferral_referrerDriverId_level_idx" ON "DriverReferral"("referrerDriverId", "level");

-- CreateIndex
CREATE INDEX "DriverReferral_referrerDriverId_isDirect_idx" ON "DriverReferral"("referrerDriverId", "isDirect");

-- CreateIndex
CREATE UNIQUE INDEX "DriverReferral_referrerDriverId_referredDriverId_key" ON "DriverReferral"("referrerDriverId", "referredDriverId");

-- CreateIndex
CREATE INDEX "RideOffer_driverId_status_idx" ON "RideOffer"("driverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RideOffer_rideRequestId_driverId_key" ON "RideOffer"("rideRequestId", "driverId");

-- CreateIndex
CREATE INDEX "ReferralRelationship_rootDriverId_idx" ON "ReferralRelationship"("rootDriverId");

-- CreateIndex
CREATE INDEX "ReferralRelationship_inviterActorType_inviterId_idx" ON "ReferralRelationship"("inviterActorType", "inviterId");

-- CreateIndex
CREATE INDEX "ReferralRelationship_flowType_idx" ON "ReferralRelationship"("flowType");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralRelationship_invitedActorType_invitedId_key" ON "ReferralRelationship"("invitedActorType", "invitedId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_code_key" ON "Skill"("code");

-- CreateIndex
CREATE INDEX "DriverSkill_skillId_idx" ON "DriverSkill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "DriverSkill_driverId_skillId_key" ON "DriverSkill"("driverId", "skillId");

-- CreateIndex
CREATE INDEX "RevenuePolicy_isActive_effectiveFrom_effectiveUntil_idx" ON "RevenuePolicy"("isActive", "effectiveFrom", "effectiveUntil");

-- CreateIndex
CREATE UNIQUE INDEX "RevenuePolicy_code_version_key" ON "RevenuePolicy"("code", "version");

-- CreateIndex
CREATE INDEX "OwnershipPolicy_isActive_effectiveFrom_effectiveUntil_idx" ON "OwnershipPolicy"("isActive", "effectiveFrom", "effectiveUntil");

-- CreateIndex
CREATE UNIQUE INDEX "OwnershipPolicy_code_version_key" ON "OwnershipPolicy"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "OwnershipSnapshot_rideId_key" ON "OwnershipSnapshot"("rideId");

-- CreateIndex
CREATE INDEX "OwnershipSnapshot_ownerId_idx" ON "OwnershipSnapshot"("ownerId");

-- CreateIndex
CREATE INDEX "OwnershipSnapshot_ownershipPolicyId_idx" ON "OwnershipSnapshot"("ownershipPolicyId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_rideRequestId_key" ON "PaymentIntent"("rideRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_externalId_key" ON "PaymentIntent"("externalId");

-- CreateIndex
CREATE INDEX "PaymentIntent_status_idx" ON "PaymentIntent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_paymentIntentId_key" ON "Settlement"("paymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_rideRequestId_key" ON "Settlement"("rideRequestId");

-- CreateIndex
CREATE INDEX "Settlement_rootDriverId_idx" ON "Settlement"("rootDriverId");

-- CreateIndex
CREATE INDEX "Settlement_revenuePolicyId_idx" ON "Settlement"("revenuePolicyId");

-- CreateIndex
CREATE INDEX "RevenueSplit_settlementId_idx" ON "RevenueSplit"("settlementId");

-- CreateIndex
CREATE INDEX "RevenueSplit_beneficiaryDriverId_idx" ON "RevenueSplit"("beneficiaryDriverId");

-- CreateIndex
CREATE INDEX "DriverLocationPing_rideRequestId_receivedAt_idx" ON "DriverLocationPing"("rideRequestId", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "DomainEvent_type_idx" ON "DomainEvent"("type");

-- CreateIndex
CREATE INDEX "DomainEvent_aggregateType_aggregateId_idx" ON "DomainEvent"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "DomainEvent_occurredAt_idx" ON "DomainEvent"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_slug_key" ON "Invite"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_token_key" ON "Invite"("token");

-- CreateIndex
CREATE INDEX "Invite_ownerActorType_ownerId_idx" ON "Invite"("ownerActorType", "ownerId");

-- CreateIndex
CREATE INDEX "Invite_expectedFlowType_idx" ON "Invite"("expectedFlowType");

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_referredByDriverId_fkey" FOREIGN KEY ("referredByDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passenger" ADD CONSTRAINT "Passenger_referredByDriverId_fkey" FOREIGN KEY ("referredByDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passenger" ADD CONSTRAINT "Passenger_referredByPassengerId_fkey" FOREIGN KEY ("referredByPassengerId") REFERENCES "Passenger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passenger" ADD CONSTRAINT "Passenger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverAvailability" ADD CONSTRAINT "DriverAvailability_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverOperationalZone" ADD CONSTRAINT "DriverOperationalZone_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverOperationalZone" ADD CONSTRAINT "DriverOperationalZone_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "OperationalZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RideRequest" ADD CONSTRAINT "RideRequest_passengerId_fkey" FOREIGN KEY ("passengerId") REFERENCES "Passenger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RideRequest" ADD CONSTRAINT "RideRequest_selectedDriverId_fkey" FOREIGN KEY ("selectedDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverReferral" ADD CONSTRAINT "DriverReferral_referrerDriverId_fkey" FOREIGN KEY ("referrerDriverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverReferral" ADD CONSTRAINT "DriverReferral_referredDriverId_fkey" FOREIGN KEY ("referredDriverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RideOffer" ADD CONSTRAINT "RideOffer_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RideOffer" ADD CONSTRAINT "RideOffer_rideRequestId_fkey" FOREIGN KEY ("rideRequestId") REFERENCES "RideRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralRelationship" ADD CONSTRAINT "ReferralRelationship_rootDriverId_fkey" FOREIGN KEY ("rootDriverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralRelationship" ADD CONSTRAINT "ReferralRelationship_inviterDriverId_fkey" FOREIGN KEY ("inviterDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverSkill" ADD CONSTRAINT "DriverSkill_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverSkill" ADD CONSTRAINT "DriverSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipSnapshot" ADD CONSTRAINT "OwnershipSnapshot_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "RideRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipSnapshot" ADD CONSTRAINT "OwnershipSnapshot_ownershipPolicyId_fkey" FOREIGN KEY ("ownershipPolicyId") REFERENCES "OwnershipPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_rideRequestId_fkey" FOREIGN KEY ("rideRequestId") REFERENCES "RideRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_rideRequestId_fkey" FOREIGN KEY ("rideRequestId") REFERENCES "RideRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_revenuePolicyId_fkey" FOREIGN KEY ("revenuePolicyId") REFERENCES "RevenuePolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueSplit" ADD CONSTRAINT "RevenueSplit_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverLocationPing" ADD CONSTRAINT "DriverLocationPing_rideRequestId_fkey" FOREIGN KEY ("rideRequestId") REFERENCES "RideRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverLocationPing" ADD CONSTRAINT "DriverLocationPing_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
