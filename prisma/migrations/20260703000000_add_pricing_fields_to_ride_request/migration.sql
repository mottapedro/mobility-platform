-- Migration: add pricing breakdown fields to RideRequest
-- These columns persist the RidePricing value object so PaymentController
-- can read the authoritative price from the DB instead of trusting the client.

ALTER TABLE "RideRequest" ADD COLUMN IF NOT EXISTS "baseFare" DOUBLE PRECISION;
ALTER TABLE "RideRequest" ADD COLUMN IF NOT EXISTS "platformFee" DOUBLE PRECISION;
ALTER TABLE "RideRequest" ADD COLUMN IF NOT EXISTS "driverNetAmount" DOUBLE PRECISION;
ALTER TABLE "RideRequest" ADD COLUMN IF NOT EXISTS "pricingVersion" TEXT;
