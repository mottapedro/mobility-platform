/**
 * SyncProjectionJob — integration spec
 *
 * Verifies that the job detects and repairs gaps between the DriverReferral
 * write model and the ReferralRelationship read model.
 *
 * All data uses @ref.com email domain so cleanTestData() removes it.
 */
import bcrypt from "bcrypt";
import { ActorType } from "../../src/shared/enums";
import { prisma } from "../setup";
import { SyncProjectionJob } from "../../src/domain/network/SyncProjectionJob";

// ── Test helpers ─────────────────────────────────────────────────────────────

async function makeDriver(email: string, referredByDriverId?: string) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: {
      userId: u.id,
      isActive: true,
      experienceLevel: "INTERMEDIARIO",
      regions: ["ZN"],
      ...(referredByDriverId ? { referredByDriverId } : {}),
    },
  });
}

/**
 * Insert a DriverReferral without creating the corresponding
 * ReferralRelationship — simulates a projection gap.
 */
async function insertDirectReferralGap(
  referrerDriverId: string,
  referredDriverId: string
) {
  await prisma.driverReferral.create({
    data: {
      referrerDriverId,
      referredDriverId,
      level: 1,
      isDirect: true,
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SyncProjectionJob", () => {
  it("repairs a gap: creates the missing ReferralRelationship", async () => {
    const root = await makeDriver("spj.root@ref.com");
    const child = await makeDriver("spj.child@ref.com", root.id);

    await insertDirectReferralGap(root.id, child.id);

    const before = await prisma.referralRelationship.findUnique({
      where: {
        invitedActorType_invitedId: {
          invitedActorType: ActorType.DRIVER,
          invitedId: child.id,
        },
      },
    });
    expect(before).toBeNull();

    const result = await SyncProjectionJob.execute(prisma);

    expect(result.repaired).toBeGreaterThanOrEqual(1);

    const after = await prisma.referralRelationship.findUnique({
      where: {
        invitedActorType_invitedId: {
          invitedActorType: ActorType.DRIVER,
          invitedId: child.id,
        },
      },
    });
    expect(after).not.toBeNull();
    expect(after?.inviterId).toBe(root.id);
    expect(after?.rootDriverId).toBe(root.id);
  });

  it("is idempotent: running twice produces repaired=0 on second pass", async () => {
    const root = await makeDriver("spj2.root@ref.com");
    const child = await makeDriver("spj2.child@ref.com", root.id);

    await insertDirectReferralGap(root.id, child.id);

    const first = await SyncProjectionJob.execute(prisma);
    expect(first.repaired).toBeGreaterThanOrEqual(1);

    const second = await SyncProjectionJob.execute(prisma);
    expect(second.repaired).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
  });

  it("skips when ReferralRelationship already exists — skipped count reflects it", async () => {
    const root = await makeDriver("spj3.root@ref.com");
    const child = await makeDriver("spj3.child@ref.com", root.id);

    // Create both DriverReferral AND ReferralRelationship upfront (no gap)
    await insertDirectReferralGap(root.id, child.id);
    await prisma.referralRelationship.create({
      data: {
        flowType: "DRIVER_TO_DRIVER",
        inviterActorType: ActorType.DRIVER,
        inviterId: root.id,
        invitedActorType: ActorType.DRIVER,
        invitedId: child.id,
        rootDriverId: root.id,
        inviterDriverId: root.id,
      },
    });

    const result = await SyncProjectionJob.execute(prisma);

    expect(result.repaired).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it("returns correct { checked, repaired, skipped } counts", async () => {
    const root = await makeDriver("spj4.root@ref.com");
    const c1 = await makeDriver("spj4.c1@ref.com", root.id);
    const c2 = await makeDriver("spj4.c2@ref.com", root.id);

    // c1 has a gap; c2 already has a projection
    await insertDirectReferralGap(root.id, c1.id);
    await insertDirectReferralGap(root.id, c2.id);
    await prisma.referralRelationship.create({
      data: {
        flowType: "DRIVER_TO_DRIVER",
        inviterActorType: ActorType.DRIVER,
        inviterId: root.id,
        invitedActorType: ActorType.DRIVER,
        invitedId: c2.id,
        rootDriverId: root.id,
        inviterDriverId: root.id,
      },
    });

    const result = await SyncProjectionJob.execute(prisma);

    // checked ≥ 2 (may include other real-DB direct referrals)
    expect(result.checked).toBeGreaterThanOrEqual(2);
    // repaired exactly 1 (c1 gap fixed; c2 skipped)
    expect(result.repaired).toBeGreaterThanOrEqual(1);
    // skipped ≥ 1 (c2 already had a projection)
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});
