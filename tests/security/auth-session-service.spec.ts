import {
  AuthSessionError,
  AuthSessionService,
} from "../../src/domain/auth/AuthSessionService";
import { prisma } from "../setup";

const CREATED_AT = new Date("2026-08-13T12:00:00.000Z");
const ONE_HOUR_MS = 60 * 60 * 1_000;

async function makeUser(email: string) {
  return prisma.user.create({
    data: {
      name: email,
      email,
      phone: "21999990000",
      role: "PASSENGER",
    },
  });
}

function serviceAt(now: Date, ttlMs = ONE_HOUR_MS) {
  return new AuthSessionService({
    now: () => now,
    refreshTokenTtlMs: ttlMs,
  });
}

function createUserLockGate() {
  let notifyAcquired!: () => void;
  let releaseLock!: () => void;
  const acquired = new Promise<void>((resolve) => {
    notifyAcquired = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  return {
    acquired,
    release: releaseLock,
    hook: async () => {
      notifyAcquired();
      await released;
    },
  };
}

describe("AuthSessionService", () => {
  it("creates an AuthSession for a User and stores only a SHA-256 hash", async () => {
    const user = await makeUser("auth.session.create@auth.com");
    const issued = await serviceAt(CREATED_AT).createSession(user.id);

    const stored = await prisma.authSession.findUniqueOrThrow({
      where: { id: issued.session.id },
    });

    expect(stored.userId).toBe(user.id);
    expect(stored.refreshTokenHash).not.toBe(issued.refreshToken);
    expect(stored.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(issued.session)).not.toContain(stored.refreshTokenHash);
  });

  it("validates the correct refresh token and rejects an incorrect token", async () => {
    const user = await makeUser("auth.session.validate@auth.com");
    const service = serviceAt(CREATED_AT);
    const issued = await service.createSession(user.id);

    await expect(service.validateRefreshToken(issued.refreshToken)).resolves.toMatchObject({
      id: issued.session.id,
      userId: user.id,
    });
    await expect(service.validateRefreshToken("incorrect-refresh-token")).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN",
    });
  });

  it("rejects an expired session", async () => {
    const user = await makeUser("auth.session.expired@auth.com");
    const issued = await serviceAt(CREATED_AT, 1_000).createSession(user.id);
    const expiredService = serviceAt(new Date(CREATED_AT.getTime() + 2_000), 1_000);

    await expect(expiredService.validateRefreshToken(issued.refreshToken)).rejects.toMatchObject({
      code: "EXPIRED_SESSION",
    });
  });

  it("rejects a revoked session", async () => {
    const user = await makeUser("auth.session.revoked@auth.com");
    const service = serviceAt(CREATED_AT);
    const issued = await service.createSession(user.id);

    expect(await service.revokeSession(issued.session.id)).toBe(true);
    await expect(service.validateRefreshToken(issued.refreshToken)).rejects.toMatchObject({
      code: "REVOKED_SESSION",
    });
  });

  it("rotates to a new refresh token in the same family and absolute expiry", async () => {
    const user = await makeUser("auth.session.rotate@auth.com");
    const initialService = serviceAt(CREATED_AT);
    const initial = await initialService.createSession(user.id);
    const rotationTime = new Date(CREATED_AT.getTime() + 30_000);

    const rotated = await serviceAt(rotationTime).rotateRefreshToken(initial.refreshToken);
    const oldRow = await prisma.authSession.findUniqueOrThrow({
      where: { id: initial.session.id },
    });

    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
    expect(rotated.session.id).not.toBe(initial.session.id);
    expect(rotated.session.familyId).toBe(initial.session.familyId);
    expect(rotated.session.expiresAt).toEqual(initial.session.expiresAt);
    expect(oldRow.rotatedAt).toEqual(rotationTime);
  });

  it("detects reuse of a rotated token and revokes its family", async () => {
    const user = await makeUser("auth.session.reuse@auth.com");
    const initialService = serviceAt(CREATED_AT);
    const initial = await initialService.createSession(user.id);
    const rotationTime = new Date(CREATED_AT.getTime() + 30_000);
    const rotatingService = serviceAt(rotationTime);
    const rotated = await rotatingService.rotateRefreshToken(initial.refreshToken);

    await expect(
      rotatingService.validateRefreshToken(initial.refreshToken),
    ).rejects.toMatchObject({ code: "REFRESH_TOKEN_REUSE_DETECTED" });
    await expect(
      rotatingService.validateRefreshToken(rotated.refreshToken),
    ).rejects.toMatchObject({ code: "REVOKED_SESSION" });

    const family = await prisma.authSession.findMany({
      where: { familyId: initial.session.familyId },
    });
    expect(family).toHaveLength(2);
    expect(family.every((session) => session.revokedAt !== null)).toBe(true);
  });

  it("revokeSession is scoped to one session", async () => {
    const user = await makeUser("auth.session.revoke-one@auth.com");
    const service = serviceAt(CREATED_AT);
    const first = await service.createSession(user.id);
    const second = await service.createSession(user.id);

    expect(await service.revokeSession(first.session.id)).toBe(true);
    expect(await service.revokeSession(first.session.id)).toBe(false);
    await expect(service.validateRefreshToken(first.refreshToken)).rejects.toBeInstanceOf(
      AuthSessionError,
    );
    await expect(service.validateRefreshToken(second.refreshToken)).resolves.toMatchObject({
      id: second.session.id,
    });
  });

  it("revokeSession revokes the whole rotation family from an older sid", async () => {
    const user = await makeUser("auth.session.revoke-family@auth.com");
    const initialService = serviceAt(CREATED_AT);
    const initial = await initialService.createSession(user.id);
    const rotationTime = new Date(CREATED_AT.getTime() + 30_000);
    const rotatingService = serviceAt(rotationTime);
    const rotated = await rotatingService.rotateRefreshToken(initial.refreshToken);

    expect(await rotatingService.revokeSession(initial.session.id)).toBe(true);
    await expect(
      rotatingService.validateRefreshToken(rotated.refreshToken),
    ).rejects.toMatchObject({ code: "REVOKED_SESSION" });
  });

  it("revokeUserSessions revokes every active session for the User", async () => {
    const user = await makeUser("auth.session.revoke-user@auth.com");
    const service = serviceAt(CREATED_AT);
    const first = await service.createSession(user.id);
    const second = await service.createSession(user.id);

    expect(await service.revokeUserSessions(user.id)).toBe(2);
    await expect(service.validateRefreshToken(first.refreshToken)).rejects.toMatchObject({
      code: "REVOKED_SESSION",
    });
    await expect(service.validateRefreshToken(second.refreshToken)).rejects.toMatchObject({
      code: "REVOKED_SESSION",
    });
  });

  it("allows exactly one successor under concurrent refresh without revoking the family", async () => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const user = await makeUser(`auth.session.concurrent-${iteration}@auth.com`);
      const initial = await serviceAt(CREATED_AT).createSession(user.id);
      const rotationTime = new Date(CREATED_AT.getTime() + 30_000);
      const gate = createUserLockGate();
      const winningService = new AuthSessionService({
        now: () => rotationTime,
        refreshTokenTtlMs: ONE_HOUR_MS,
        afterUserLockAcquired: gate.hook,
      });

      const winningRotation = winningService.rotateRefreshToken(initial.refreshToken);
      await gate.acquired;
      try {
        await expect(
          serviceAt(rotationTime).rotateRefreshToken(initial.refreshToken),
        ).rejects.toMatchObject({ code: "CONCURRENT_REFRESH_CONFLICT" });
      } finally {
        gate.release();
      }
      const successor = await winningRotation;

      const family = await prisma.authSession.findMany({
        where: { familyId: initial.session.familyId },
        orderBy: { createdAt: "asc" },
      });
      expect(family).toHaveLength(2);
      expect(family.filter((session) => session.rotatedAt !== null)).toHaveLength(1);
      expect(family.filter((session) => session.revokedAt === null)).toHaveLength(2);
      await expect(
        serviceAt(rotationTime).validateRefreshToken(successor.refreshToken),
      ).resolves.toMatchObject({ id: successor.session.id });
    }
  });

  it.each([0, 1, 2])(
    "revokes a successor when revokeSession completes after a concurrent rotation (%i)",
    async (iteration) => {
      const user = await makeUser(
        `auth.session.rotate-revoke-${iteration}@auth.com`,
      );
      const initial = await serviceAt(CREATED_AT).createSession(user.id);
      const rotationTime = new Date(CREATED_AT.getTime() + 30_000);
      const gate = createUserLockGate();
      const rotatingService = new AuthSessionService({
        now: () => rotationTime,
        refreshTokenTtlMs: ONE_HOUR_MS,
        afterUserLockAcquired: gate.hook,
      });

      const rotation = rotatingService.rotateRefreshToken(initial.refreshToken);
      await gate.acquired;
      const revocation = serviceAt(rotationTime).revokeSession(initial.session.id);
      gate.release();

      const [successor, revoked] = await Promise.all([rotation, revocation]);
      expect(revoked).toBe(true);
      await expect(
        serviceAt(rotationTime).validateRefreshToken(successor.refreshToken),
      ).rejects.toMatchObject({ code: "REVOKED_SESSION" });
      await expect(
        serviceAt(rotationTime).rotateRefreshToken(successor.refreshToken),
      ).rejects.toMatchObject({ code: "REVOKED_SESSION" });
      const activeCount = await prisma.authSession.count({
        where: { familyId: initial.session.familyId, revokedAt: null },
      });
      expect(activeCount).toBe(0);
    },
  );

  it.each([0, 1, 2])(
    "prevents rotation while revokeSession owns the user lock (%i)",
    async (iteration) => {
      const user = await makeUser(
        `auth.session.revoke-rotate-${iteration}@auth.com`,
      );
      const initial = await serviceAt(CREATED_AT).createSession(user.id);
      const operationTime = new Date(CREATED_AT.getTime() + 30_000);
      const gate = createUserLockGate();
      const revokingService = new AuthSessionService({
        now: () => operationTime,
        refreshTokenTtlMs: ONE_HOUR_MS,
        afterUserLockAcquired: gate.hook,
      });

      const revocation = revokingService.revokeSession(initial.session.id);
      await gate.acquired;
      try {
        await expect(
          serviceAt(operationTime).rotateRefreshToken(initial.refreshToken),
        ).rejects.toMatchObject({ code: "CONCURRENT_REFRESH_CONFLICT" });
      } finally {
        gate.release();
      }
      expect(await revocation).toBe(true);

      const family = await prisma.authSession.findMany({
        where: { familyId: initial.session.familyId },
      });
      expect(family).toHaveLength(1);
      expect(family[0].revokedAt).toEqual(operationTime);
    },
  );

  it.each([0, 1, 2])(
    "prevents rotation while revokeUserSessions owns the user lock (%i)",
    async (iteration) => {
      const user = await makeUser(
        `auth.session.revoke-user-rotate-${iteration}@auth.com`,
      );
      const first = await serviceAt(CREATED_AT).createSession(user.id);
      await serviceAt(CREATED_AT).createSession(user.id);
      const operationTime = new Date(CREATED_AT.getTime() + 30_000);
      const gate = createUserLockGate();
      const revokingService = new AuthSessionService({
        now: () => operationTime,
        refreshTokenTtlMs: ONE_HOUR_MS,
        afterUserLockAcquired: gate.hook,
      });

      const revocation = revokingService.revokeUserSessions(user.id);
      await gate.acquired;
      try {
        await expect(
          serviceAt(operationTime).rotateRefreshToken(first.refreshToken),
        ).rejects.toMatchObject({ code: "CONCURRENT_REFRESH_CONFLICT" });
      } finally {
        gate.release();
      }
      expect(await revocation).toBe(2);

      const activeCount = await prisma.authSession.count({
        where: { userId: user.id, revokedAt: null },
      });
      expect(activeCount).toBe(0);
      await expect(
        serviceAt(operationTime).rotateRefreshToken(first.refreshToken),
      ).rejects.toMatchObject({ code: "REVOKED_SESSION" });
    },
  );

  it.each([0, 1, 2])(
    "does not let concurrent validation reactivate or mask a rotated token (%i)",
    async (iteration) => {
      const user = await makeUser(
        `auth.session.validate-rotate-${iteration}@auth.com`,
      );
      const initial = await serviceAt(CREATED_AT).createSession(user.id);
      const rotationTime = new Date(CREATED_AT.getTime() + 30_000);
      const gate = createUserLockGate();
      const rotatingService = new AuthSessionService({
        now: () => rotationTime,
        refreshTokenTtlMs: ONE_HOUR_MS,
        afterUserLockAcquired: gate.hook,
      });

      const rotation = rotatingService.rotateRefreshToken(initial.refreshToken);
      await gate.acquired;
      try {
        await expect(
          serviceAt(rotationTime).validateRefreshToken(initial.refreshToken),
        ).rejects.toMatchObject({ code: "CONCURRENT_REFRESH_CONFLICT" });
      } finally {
        gate.release();
      }
      const successor = await rotation;

      const oldSession = await prisma.authSession.findUniqueOrThrow({
        where: { id: initial.session.id },
      });
      expect(oldSession.rotatedAt).toEqual(rotationTime);
      expect(oldSession.revokedAt).toBeNull();
      expect(successor.session.expiresAt).toEqual(initial.session.expiresAt);
      expect(
        await prisma.authSession.count({
          where: { familyId: initial.session.familyId, rotatedAt: null },
        }),
      ).toBe(1);
      await expect(
        serviceAt(rotationTime).rotateRefreshToken(initial.refreshToken),
      ).rejects.toMatchObject({ code: "REFRESH_TOKEN_REUSE_DETECTED" });
      expect(
        await prisma.authSession.count({
          where: { familyId: initial.session.familyId },
        }),
      ).toBe(2);
    },
  );

  it.each([0, 1, 2])(
    "never renews an expired token during a concurrent rotation attempt (%i)",
    async (iteration) => {
      const user = await makeUser(
        `auth.session.expired-concurrent-${iteration}@auth.com`,
      );
      const initial = await serviceAt(CREATED_AT, 1_000).createSession(user.id);
      const expiredAt = new Date(CREATED_AT.getTime() + 2_000);
      const gate = createUserLockGate();
      const firstService = new AuthSessionService({
        now: () => expiredAt,
        refreshTokenTtlMs: 1_000,
        afterUserLockAcquired: gate.hook,
      });

      const firstAttempt = firstService.rotateRefreshToken(initial.refreshToken);
      await gate.acquired;
      try {
        await expect(
          serviceAt(expiredAt, 1_000).rotateRefreshToken(initial.refreshToken),
        ).rejects.toMatchObject({ code: "CONCURRENT_REFRESH_CONFLICT" });
      } finally {
        gate.release();
      }
      await expect(firstAttempt).rejects.toMatchObject({
        code: "EXPIRED_SESSION",
      });

      const family = await prisma.authSession.findMany({
        where: { familyId: initial.session.familyId },
      });
      expect(family).toHaveLength(1);
      expect(family[0].rotatedAt).toBeNull();
      expect(family[0].expiresAt).toEqual(initial.session.expiresAt);
    },
  );
});
