-- Migration: Re-introduce PENDING to RideOfferStatus
-- This migration adds the PENDING value back to the RideOfferStatus enum.
-- This is necessary as the application logic fundamentally relies on a "pending"
-- state for offers that have been created but not yet responded to.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = '"RideOfferStatus"'::regtype AND enumlabel = 'PENDING') THEN
        ALTER TYPE "RideOfferStatus" ADD VALUE 'PENDING';
    END IF;
END;
$$;
