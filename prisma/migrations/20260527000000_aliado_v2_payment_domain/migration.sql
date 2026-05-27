-- Aliado Nacional V2 — PR-2: Payment domain
-- PaymentIntent → Settlement → RevenueSplit + DomainEvent
-- Plus: RideStatus.PAID

-- 1) New enums
DO $$ BEGIN
    CREATE TYPE "PaymentMethod" AS ENUM ('PIX');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "SplitBeneficiaryType" AS ENUM ('DRIVER', 'PLATFORM', 'ROOT_DRIVER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "DomainEventType" AS ENUM (
        'PAYMENT_INTENT_CREATED',
        'PIX_QRCODE_GENERATED',
        'PAYMENT_CONFIRMED',
        'PAYMENT_FAILED',
        'RIDE_SETTLED',
        'REWARD_DISTRIBUTED'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ensure base DomainEventType values exist even if the type was pre-created
-- by an earlier migration (e.g. 20260526190329_add_driver_referred_event).
ALTER TYPE "DomainEventType" ADD VALUE IF NOT EXISTS 'PAYMENT_INTENT_CREATED';
ALTER TYPE "DomainEventType" ADD VALUE IF NOT EXISTS 'PIX_QRCODE_GENERATED';
ALTER TYPE "DomainEventType" ADD VALUE IF NOT EXISTS 'PAYMENT_CONFIRMED';
ALTER TYPE "DomainEventType" ADD VALUE IF NOT EXISTS 'PAYMENT_FAILED';
ALTER TYPE "DomainEventType" ADD VALUE IF NOT EXISTS 'RIDE_SETTLED';
ALTER TYPE "DomainEventType" ADD VALUE IF NOT EXISTS 'REWARD_DISTRIBUTED';

-- 2) Add PAID to RideStatus
ALTER TYPE "RideStatus" ADD VALUE IF NOT EXISTS 'PAID';

-- 3) PaymentIntent
CREATE TABLE IF NOT EXISTS "PaymentIntent" (
    "id"            TEXT PRIMARY KEY,
    "rideRequestId" TEXT NOT NULL UNIQUE,
    "amountCents"   INTEGER NOT NULL,
    "method"        "PaymentMethod" NOT NULL DEFAULT 'PIX',
    "status"        "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "externalId"    TEXT UNIQUE,
    "qrCode"        TEXT,
    "qrCodeImage"   TEXT,
    "confirmedAt"   TIMESTAMP(3),
    "failedAt"      TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentIntent_rideRequestId_fkey"
        FOREIGN KEY ("rideRequestId") REFERENCES "RideRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "PaymentIntent_status_idx" ON "PaymentIntent"("status");

-- 4) Settlement
CREATE TABLE IF NOT EXISTS "Settlement" (
    "id"               TEXT PRIMARY KEY,
    "paymentIntentId"  TEXT NOT NULL UNIQUE,
    "rideRequestId"    TEXT NOT NULL UNIQUE,
    "totalCents"       INTEGER NOT NULL,
    "driverCents"      INTEGER NOT NULL,
    "platformCents"    INTEGER NOT NULL,
    "rootDriverCents"  INTEGER NOT NULL,
    "rootDriverId"     TEXT,
    "settledAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Settlement_paymentIntentId_fkey"
        FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Settlement_rideRequestId_fkey"
        FOREIGN KEY ("rideRequestId") REFERENCES "RideRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 5) RevenueSplit
CREATE TABLE IF NOT EXISTS "RevenueSplit" (
    "id"                  TEXT PRIMARY KEY,
    "settlementId"        TEXT NOT NULL,
    "beneficiaryType"     "SplitBeneficiaryType" NOT NULL,
    "beneficiaryDriverId" TEXT,
    "amountCents"         INTEGER NOT NULL,
    "percentBps"          INTEGER NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RevenueSplit_settlementId_fkey"
        FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "RevenueSplit_settlementId_idx"        ON "RevenueSplit"("settlementId");
CREATE INDEX IF NOT EXISTS "RevenueSplit_beneficiaryDriverId_idx" ON "RevenueSplit"("beneficiaryDriverId");

-- 6) DomainEvent
CREATE TABLE IF NOT EXISTS "DomainEvent" (
    "id"            TEXT PRIMARY KEY,
    "type"          "DomainEventType" NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId"   TEXT NOT NULL,
    "payload"       JSONB NOT NULL,
    "occurredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "DomainEvent_type_idx"                   ON "DomainEvent"("type");
CREATE INDEX IF NOT EXISTS "DomainEvent_aggregateType_aggregateId_idx" ON "DomainEvent"("aggregateType", "aggregateId");
CREATE INDEX IF NOT EXISTS "DomainEvent_occurredAt_idx"             ON "DomainEvent"("occurredAt");
