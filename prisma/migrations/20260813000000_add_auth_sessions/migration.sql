-- Authentication session foundation: opaque refresh tokens are stored only as hashes.
CREATE TABLE "AuthSession" (
  "id"               TEXT         NOT NULL,
  "userId"           TEXT         NOT NULL,
  "refreshTokenHash" TEXT         NOT NULL,
  "familyId"         TEXT         NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"        TIMESTAMP(3) NOT NULL,
  "lastUsedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rotatedAt"        TIMESTAMP(3),
  "revokedAt"        TIMESTAMP(3),

  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthSession_refreshTokenHash_key"
  ON "AuthSession"("refreshTokenHash");

CREATE INDEX "AuthSession_userId_idx"
  ON "AuthSession"("userId");

CREATE INDEX "AuthSession_familyId_idx"
  ON "AuthSession"("familyId");

CREATE INDEX "AuthSession_expiresAt_idx"
  ON "AuthSession"("expiresAt");

ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_userId_fkey"
  FOREIGN KEY ("userId")
  REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
