import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "crypto";
import { AuthSession, Prisma } from "@prisma/client";
import { loadRefreshTokenTtlMs } from "../../config/auth";
import { prisma } from "../../infra/prisma/client";

const DEFAULT_REFRESH_TOKEN_BYTES = 32;

export type AuthSessionErrorCode =
  | "INVALID_REFRESH_TOKEN"
  | "EXPIRED_SESSION"
  | "REVOKED_SESSION"
  | "CONCURRENT_REFRESH_CONFLICT"
  | "REFRESH_TOKEN_REUSE_DETECTED";

export class AuthSessionError extends Error {
  constructor(public readonly code: AuthSessionErrorCode) {
    super(code);
    this.name = "AuthSessionError";
  }
}

export interface AuthSessionView {
  id: string;
  userId: string;
  familyId: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export interface IssuedAuthSession {
  session: AuthSessionView;
  refreshToken: string;
}

interface AuthSessionServiceOptions {
  refreshTokenTtlMs?: number;
  refreshTokenBytes?: number;
  now?: () => Date;
  // Coordination seam used to prove lock interleavings against real PostgreSQL.
  // It runs only after the transaction owns the per-user row lock.
  afterUserLockAcquired?: (operation: AuthSessionOperation) => Promise<void>;
}

type AuthSessionOperation =
  | "validate"
  | "rotate"
  | "revokeSession"
  | "revokeUserSessions";

type RotationResult =
  | { state: "ok"; session: AuthSession }
  | { state: "invalid" }
  | { state: "expired" }
  | { state: "revoked" }
  | { state: "reuse" };

type ValidationResult =
  | { state: "ok"; session: AuthSession }
  | Exclude<RotationResult, { state: "ok" }>;

type LockedUserRow = { id: string };
type LockedSessionRow = { id: string };
type LockTransaction = Pick<Prisma.TransactionClient, "$queryRaw">;

function isConcurrencyConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (error.code === "P2034") {
    return true;
  }

  if (error.code !== "P2010") {
    return false;
  }

  const meta = error.meta as
    | {
        driverAdapterError?: {
          cause?: { originalCode?: string };
        };
      }
    | undefined;
  return meta?.driverAdapterError?.cause?.originalCode === "55P03";
}

async function lockUserNowait(
  tx: LockTransaction,
  userId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<LockedUserRow[]>`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${userId}
    FOR UPDATE NOWAIT
  `;
  return rows.length === 1;
}

async function lockUser(
  tx: LockTransaction,
  userId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<LockedUserRow[]>`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${userId}
    FOR UPDATE
  `;
  return rows.length === 1;
}

async function lockSessionNowait(
  tx: LockTransaction,
  sessionId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<LockedSessionRow[]>`
    SELECT "id"
    FROM "AuthSession"
    WHERE "id" = ${sessionId}
    FOR UPDATE NOWAIT
  `;
  return rows.length === 1;
}

async function lockFamily(
  tx: LockTransaction,
  familyId: string,
): Promise<void> {
  await tx.$queryRaw<LockedSessionRow[]>`
    SELECT "id"
    FROM "AuthSession"
    WHERE "familyId" = ${familyId}
    ORDER BY "id"
    FOR UPDATE
  `;
}

async function lockUserSessions(
  tx: LockTransaction,
  userId: string,
): Promise<void> {
  await tx.$queryRaw<LockedSessionRow[]>`
    SELECT "id"
    FROM "AuthSession"
    WHERE "userId" = ${userId}
    ORDER BY "id"
    FOR UPDATE
  `;
}

function generateRefreshToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function hashRefreshToken(refreshToken: string): string {
  return createHash("sha256").update(refreshToken, "utf8").digest("hex");
}

function hashesEqual(storedHash: string, candidateHash: string): boolean {
  const stored = Buffer.from(storedHash, "hex");
  const candidate = Buffer.from(candidateHash, "hex");
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

function toSessionView(session: AuthSession): AuthSessionView {
  return {
    id: session.id,
    userId: session.userId,
    familyId: session.familyId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastUsedAt: session.lastUsedAt,
    rotatedAt: session.rotatedAt,
    revokedAt: session.revokedAt,
  };
}

function throwForRotationState(state: Exclude<RotationResult["state"], "ok">): never {
  if (state === "invalid") {
    throw new AuthSessionError("INVALID_REFRESH_TOKEN");
  }
  if (state === "expired") {
    throw new AuthSessionError("EXPIRED_SESSION");
  }
  if (state === "revoked") {
    throw new AuthSessionError("REVOKED_SESSION");
  }
  throw new AuthSessionError("REFRESH_TOKEN_REUSE_DETECTED");
}

export class AuthSessionService {
  private readonly refreshTokenTtlMs: number;
  private readonly refreshTokenBytes: number;
  private readonly now: () => Date;
  private readonly afterUserLockAcquired?: (
    operation: AuthSessionOperation,
  ) => Promise<void>;

  constructor(options: AuthSessionServiceOptions = {}) {
    this.refreshTokenTtlMs =
      options.refreshTokenTtlMs ?? loadRefreshTokenTtlMs();
    this.refreshTokenBytes =
      options.refreshTokenBytes ?? DEFAULT_REFRESH_TOKEN_BYTES;
    this.now = options.now ?? (() => new Date());
    this.afterUserLockAcquired = options.afterUserLockAcquired;

    if (
      !Number.isSafeInteger(this.refreshTokenTtlMs) ||
      this.refreshTokenTtlMs <= 0
    ) {
      throw new Error("refreshTokenTtlMs must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(this.refreshTokenBytes) ||
      this.refreshTokenBytes < DEFAULT_REFRESH_TOKEN_BYTES
    ) {
      throw new Error(
        `refreshTokenBytes must be at least ${DEFAULT_REFRESH_TOKEN_BYTES}`,
      );
    }
  }

  async createSession(userId: string): Promise<IssuedAuthSession> {
    if (!userId) {
      throw new Error("userId is required");
    }

    const now = this.now();
    const refreshToken = generateRefreshToken(this.refreshTokenBytes);
    const session = await prisma.authSession.create({
      data: {
        userId,
        familyId: randomUUID(),
        refreshTokenHash: hashRefreshToken(refreshToken),
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + this.refreshTokenTtlMs),
      },
    });

    return { session: toSessionView(session), refreshToken };
  }

  /**
   * Inspects an existing refresh credential and records last use atomically.
   * This method does not consume the token and must not be composed as
   * validate(A) -> rotate(A); rotateRefreshToken owns that full atomic boundary.
   */
  async validateRefreshToken(refreshToken: string): Promise<AuthSessionView> {
    if (!refreshToken) {
      throw new AuthSessionError("INVALID_REFRESH_TOKEN");
    }

    const candidateHash = hashRefreshToken(refreshToken);
    const now = this.now();
    let result: ValidationResult;

    try {
      result = await prisma.$transaction(async (tx) => {
        const candidate = await tx.authSession.findUnique({
          where: { refreshTokenHash: candidateHash },
        });

        if (!candidate || !hashesEqual(candidate.refreshTokenHash, candidateHash)) {
          return { state: "invalid" } as const;
        }
        if (!(await lockUserNowait(tx, candidate.userId))) {
          return { state: "invalid" } as const;
        }
        await this.afterUserLockAcquired?.("validate");
        if (!(await lockSessionNowait(tx, candidate.id))) {
          return { state: "invalid" } as const;
        }

        const session = await tx.authSession.findUnique({
          where: { id: candidate.id },
        });
        if (!session || !hashesEqual(session.refreshTokenHash, candidateHash)) {
          return { state: "invalid" } as const;
        }
        if (session.rotatedAt) {
          await lockFamily(tx, session.familyId);
          await tx.authSession.updateMany({
            where: { familyId: session.familyId, revokedAt: null },
            data: { revokedAt: now },
          });
          return { state: "reuse" } as const;
        }
        if (session.revokedAt) {
          return { state: "revoked" } as const;
        }
        if (session.expiresAt.getTime() <= now.getTime()) {
          return { state: "expired" } as const;
        }

        const updated = await tx.authSession.update({
          where: { id: session.id },
          data: { lastUsedAt: now },
        });
        return { state: "ok", session: updated } as const;
      });
    } catch (error) {
      if (isConcurrencyConflict(error)) {
        throw new AuthSessionError("CONCURRENT_REFRESH_CONFLICT");
      }
      throw error;
    }

    if (result.state !== "ok") {
      throwForRotationState(result.state);
    }
    return toSessionView(result.session);
  }

  async rotateRefreshToken(refreshToken: string): Promise<IssuedAuthSession> {
    if (!refreshToken) {
      throw new AuthSessionError("INVALID_REFRESH_TOKEN");
    }

    const currentHash = hashRefreshToken(refreshToken);
    const nextRefreshToken = generateRefreshToken(this.refreshTokenBytes);
    const nextHash = hashRefreshToken(nextRefreshToken);
    const now = this.now();

    let result: RotationResult;
    try {
      result = await prisma.$transaction(async (tx) => {
        const candidate = await tx.authSession.findUnique({
          where: { refreshTokenHash: currentHash },
        });

        if (!candidate || !hashesEqual(candidate.refreshTokenHash, currentHash)) {
          return { state: "invalid" } as const;
        }
        if (!(await lockUserNowait(tx, candidate.userId))) {
          return { state: "invalid" } as const;
        }
        await this.afterUserLockAcquired?.("rotate");
        if (!(await lockSessionNowait(tx, candidate.id))) {
          return { state: "invalid" } as const;
        }

        const current = await tx.authSession.findUnique({
          where: { id: candidate.id },
        });
        if (!current || !hashesEqual(current.refreshTokenHash, currentHash)) {
          return { state: "invalid" } as const;
        }
        if (current.rotatedAt) {
          await lockFamily(tx, current.familyId);
          await tx.authSession.updateMany({
            where: { familyId: current.familyId, revokedAt: null },
            data: { revokedAt: now },
          });
          return { state: "reuse" } as const;
        }
        if (current.revokedAt) {
          return { state: "revoked" } as const;
        }
        if (current.expiresAt.getTime() <= now.getTime()) {
          return { state: "expired" } as const;
        }

        const rotated = await tx.authSession.updateMany({
          where: {
            id: current.id,
            rotatedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { rotatedAt: now, lastUsedAt: now },
        });

        if (rotated.count !== 1) {
          await tx.authSession.updateMany({
            where: { familyId: current.familyId, revokedAt: null },
            data: { revokedAt: now },
          });
          return { state: "reuse" } as const;
        }

        const nextSession = await tx.authSession.create({
          data: {
            userId: current.userId,
            familyId: current.familyId,
            refreshTokenHash: nextHash,
            createdAt: now,
            lastUsedAt: now,
            expiresAt: current.expiresAt,
          },
        });
        return { state: "ok", session: nextSession } as const;
      });
    } catch (error) {
      if (isConcurrencyConflict(error)) {
        throw new AuthSessionError("CONCURRENT_REFRESH_CONFLICT");
      }
      throw error;
    }

    if (result.state !== "ok") {
      throwForRotationState(result.state);
    }

    return {
      session: toSessionView(result.session),
      refreshToken: nextRefreshToken,
    };
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    if (!sessionId) {
      throw new Error("sessionId is required");
    }

    return prisma.$transaction(async (tx) => {
      const candidate = await tx.authSession.findUnique({
        where: { id: sessionId },
        select: { userId: true },
      });
      if (!candidate || !(await lockUser(tx, candidate.userId))) {
        return false;
      }
      await this.afterUserLockAcquired?.("revokeSession");

      const session = await tx.authSession.findUnique({
        where: { id: sessionId },
        select: { familyId: true },
      });
      if (!session) {
        return false;
      }
      await lockFamily(tx, session.familyId);

      const result = await tx.authSession.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: this.now() },
      });
      return result.count > 0;
    });
  }

  async revokeUserSessions(userId: string): Promise<number> {
    if (!userId) {
      throw new Error("userId is required");
    }

    return prisma.$transaction(async (tx) => {
      if (!(await lockUser(tx, userId))) {
        return 0;
      }
      await this.afterUserLockAcquired?.("revokeUserSessions");
      await lockUserSessions(tx, userId);

      const result = await tx.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: this.now() },
      });
      return result.count;
    });
  }
}
