-- Add the non-terminal RideRequest status used for owner recovery.
ALTER TYPE "RideStatus" ADD VALUE IF NOT EXISTS 'WAITING_OWNER';
