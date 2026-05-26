/**
 * Backfill idempotency spec.
 *
 * The backfill script itself is a CLI; here we verify the underlying contract
 * the script relies on:
 *   recordRelationship is idempotent on (invitedActorType, invitedId), so a
 *   second pass over the same legacy edges produces zero new rows.
 */
import bcrypt from "bcrypt";
import { ActorType } from "../../src/shared/enums";
import { prisma } from "../setup";
import { recordRelationship } from "../../src/domain/referral-network/ReferralRelationshipService";

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

async function backfillDriverToDriverOnce(rootId?: string) {
  const drivers = await prisma.driver.findMany({
    where: { referredByDriverId: rootId !== undefined ? rootId : { not: null } },
    select: { id: true, referredByDriverId: true },
  });
  let created = 0;
  let skipped = 0;
  for (const d of drivers) {
    const before = await prisma.referralRelationship.findUnique({
      where: {
        invitedActorType_invitedId: {
          invitedActorType: ActorType.DRIVER,
          invitedId: d.id,
        },
      },
    });
    await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: d.referredByDriverId!,
      invitedActorType: ActorType.DRIVER,
      invitedId: d.id,
    });
    if (before) skipped++;
    else created++;
  }
  return { processed: drivers.length, created, skipped };
}

describe("Backfill — referral relationships idempotency", () => {
  it("second pass over legacy edges creates 0 new rows", async () => {
    const root = await makeDriver("bf.root@backfill.test");
    await makeDriver("bf.c1@backfill.test", root.id);
    await makeDriver("bf.c2@backfill.test", root.id);

    const first = await backfillDriverToDriverOnce(root.id);
    expect(first.created).toBe(2);
    expect(first.skipped).toBe(0);

    const second = await backfillDriverToDriverOnce(root.id);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(2);
  });
});
