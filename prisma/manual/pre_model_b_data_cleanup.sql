-- Data Cleanup Script for Model B Lifecycle Migration
-- This script updates legacy status values in RideRequest and RideOffer
-- to conform to the new, simplified state machine before applying the
-- schema migration. This ensures that no data is left in a state that
-- the new schema version would not recognize.

-- Update RideRequest statuses:
-- Consolidate various "waiting" and "in-progress" states into two
-- canonical states: 'REQUESTED' for pre-acceptance and 'STARTED' for post-acceptance.
UPDATE "RideRequest"
SET status = 'REQUESTED'
WHERE status IN (
  'WAITING_PARTNER',
  'WAITING_DRIVER',
  'WAITING_GENERAL',
  'WAITING_REFERRAL',
  'PENDING'
);

UPDATE "RideRequest"
SET status = 'STARTED'
WHERE status = 'IN_PROGRESS';

-- Update RideOffer statuses:
-- Rename legacy statuses to their new, more descriptive equivalents.
UPDATE "RideOffer"
SET status = 'OFFER_EXPIRED'
WHERE status = 'EXPIRED';

UPDATE "RideOffer"
SET status = 'OFFER_DECLINED'
WHERE status = 'REJECTED';

