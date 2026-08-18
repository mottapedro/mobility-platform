-- Pre-Migration: Data Cleanup for Model B
-- Run THIS FIRST before model-b-lifecycle-separation.sql

BEGIN;

-- ============================================================================
-- RideRequest: Normalize old dispatch-stage-as-status values to REQUESTED
-- ============================================================================
UPDATE "RideRequest"
SET status = 'REQUESTED'
WHERE status IN ('PENDING', 'WAITING_DRIVER', 'WAITING_REFERRAL', 'WAITING_PARTNER', 'WAITING_GENERAL');

-- RideRequest: Normalize IN_PROGRESS to STARTED
UPDATE "RideRequest"
SET status = 'STARTED'
WHERE status = 'IN_PROGRESS';

-- ============================================================================
-- RideOffer: Normalize to new naming convention
-- ============================================================================
UPDATE "RideOffer"
SET status = 'OFFER_EXPIRED'
WHERE status = 'EXPIRED';

--UPDATE "RideOffer"
--SET status = 'OFFER_DECLINED'
--WHERE status = 'REJECTED';

-- ============================================================================
-- Verification queries (should return 0 rows each)
-- ============================================================================
-- SELECT * FROM "RideRequest" WHERE status NOT IN ('REQUESTED', 'ACCEPTED', 'STARTED', 'COMPLETED', 'CANCELLED', 'EXPIRED');
-- SELECT * FROM "RideOffer" WHERE status NOT IN ('OFFER_CREATED', 'OFFER_VIEWED', 'OFFER_ACCEPTED', 'OFFER_DECLINED', 'OFFER_EXPIRED', 'OFFER_CANCELLED');

COMMIT;

-- Expected results:
-- RideRequest: 27 rows updated (9+4+4+4+4+2 → REQUESTED, 4 → STARTED)
-- RideOffer: 410 rows updated (404 → OFFER_EXPIRED, 6 → OFFER_DECLINED)
