-- Migration: Expand Lifecycle Enums
-- Phase 1 of Lifecycle Stabilization Sprint: Expand enums with new values.
-- This migration is non-destructive. It only adds new values to the existing
-- PostgreSQL enums, allowing the application and data cleanup scripts to
-- start using them before the legacy values are removed.

-- Add new values to RideStatus
-- Note: Using "IF NOT EXISTS" for idempotency, preventing errors on re-run.
ALTER TYPE "RideStatus" ADD VALUE IF NOT EXISTS 'REQUESTED';
ALTER TYPE "RideStatus" ADD VALUE IF NOT EXISTS 'STARTED';

-- Add new values to RideOfferStatus
ALTER TYPE "RideOfferStatus" ADD VALUE IF NOT EXISTS 'OFFER_CREATED';
ALTER TYPE "RideOfferStatus" ADD VALUE IF NOT EXISTS 'OFFER_DECLINED';
ALTER TYPE "RideOfferStatus" ADD VALUE IF NOT EXISTS 'OFFER_EXPIRED';