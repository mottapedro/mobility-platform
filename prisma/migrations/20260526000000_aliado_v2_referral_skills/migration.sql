-- Aliado Nacional V2 — relational network + first-class driver skills.
-- Additive only; all new columns nullable; no destructive operations.

-- ── Enums ───────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ReferralFlowType" AS ENUM ('DRIVER_TO_DRIVER', 'DRIVER_TO_PASSENGER', 'PASSENGER_TO_PASSENGER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ActorType" AS ENUM ('DRIVER', 'PASSENGER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DriverSkillCode" AS ENUM (
    'COLECIONADOR',
    'EXECUTIVO',
    'TRANSPORTE_ASSISTIDO',
    'AEROPORTO',
    'LONG_DISTANCE',
    'PREMIUM',
    'VIP'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Operational root on Passenger / RideRequest ────────────────────────────
ALTER TABLE "Passenger" ADD COLUMN IF NOT EXISTS "rootDriverId" TEXT;
ALTER TABLE "RideRequest" ADD COLUMN IF NOT EXISTS "rootDriverId" TEXT;

-- ── ReferralRelationship table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ReferralRelationship" (
  "id"               TEXT PRIMARY KEY,
  "flowType"         "ReferralFlowType" NOT NULL,
  "inviterActorType" "ActorType"        NOT NULL,
  "inviterId"        TEXT               NOT NULL,
  "invitedActorType" "ActorType"        NOT NULL,
  "invitedId"        TEXT               NOT NULL,
  "rootDriverId"     TEXT               NOT NULL,
  "inviterDriverId"  TEXT,
  "createdAt"        TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralRelationship_rootDriver_fkey"
    FOREIGN KEY ("rootDriverId") REFERENCES "Driver"("id"),
  CONSTRAINT "ReferralRelationship_inviterDriver_fkey"
    FOREIGN KEY ("inviterDriverId") REFERENCES "Driver"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReferralRelationship_invited_unique"
  ON "ReferralRelationship" ("invitedActorType", "invitedId");
CREATE INDEX IF NOT EXISTS "ReferralRelationship_rootDriver_idx"
  ON "ReferralRelationship" ("rootDriverId");
CREATE INDEX IF NOT EXISTS "ReferralRelationship_inviter_idx"
  ON "ReferralRelationship" ("inviterActorType", "inviterId");
CREATE INDEX IF NOT EXISTS "ReferralRelationship_flowType_idx"
  ON "ReferralRelationship" ("flowType");

-- ── Skill catalogue ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Skill" (
  "id"          TEXT PRIMARY KEY,
  "code"        "DriverSkillCode" NOT NULL UNIQUE,
  "displayName" TEXT              NOT NULL,
  "description" TEXT,
  "isActive"    BOOLEAN           NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── DriverSkill join ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DriverSkill" (
  "id"         TEXT PRIMARY KEY,
  "driverId"   TEXT             NOT NULL,
  "skillId"    TEXT             NOT NULL,
  "level"      INTEGER          NOT NULL DEFAULT 1,
  "unlockedAt" TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata"   JSONB,
  CONSTRAINT "DriverSkill_driver_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id"),
  CONSTRAINT "DriverSkill_skill_fkey"  FOREIGN KEY ("skillId")  REFERENCES "Skill"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DriverSkill_driver_skill_unique"
  ON "DriverSkill" ("driverId", "skillId");
CREATE INDEX IF NOT EXISTS "DriverSkill_skill_idx"
  ON "DriverSkill" ("skillId");

-- ── Skill catalogue seed ────────────────────────────────────────────────────
INSERT INTO "Skill" ("id", "code", "displayName", "description") VALUES
  (gen_random_uuid()::text, 'COLECIONADOR',         'Colecionador',          'Motorista com perfil de recorrência e fidelização.'),
  (gen_random_uuid()::text, 'EXECUTIVO',            'Executivo',             'Atende corridas executivas.'),
  (gen_random_uuid()::text, 'TRANSPORTE_ASSISTIDO', 'Transporte Assistido',  'Habilitado para passageiros que necessitam de apoio.'),
  (gen_random_uuid()::text, 'AEROPORTO',            'Aeroporto',             'Especialista em corridas para/de aeroporto.'),
  (gen_random_uuid()::text, 'LONG_DISTANCE',        'Longa Distância',       'Corridas intermunicipais.'),
  (gen_random_uuid()::text, 'PREMIUM',              'Premium',               'Veículo e atendimento premium.'),
  (gen_random_uuid()::text, 'VIP',                  'VIP',                   'Atendimento VIP.')
ON CONFLICT ("code") DO NOTHING;
