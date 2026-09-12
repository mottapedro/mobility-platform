-- Represent offers terminated because their parent demand was explicitly cancelled.
ALTER TYPE "RideOfferStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
