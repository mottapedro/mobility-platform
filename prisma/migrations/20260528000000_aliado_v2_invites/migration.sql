-- Phase A (PR-3 / Aliado V2.1): operational invite slugs.
CREATE TABLE IF NOT EXISTS "Invite" (
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

CREATE UNIQUE INDEX IF NOT EXISTS "Invite_slug_key" ON "Invite"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "Invite_token_key" ON "Invite"("token");
CREATE INDEX IF NOT EXISTS "Invite_owner_idx" ON "Invite"("ownerActorType", "ownerId");
CREATE INDEX IF NOT EXISTS "Invite_expectedFlowType_idx" ON "Invite"("expectedFlowType");
