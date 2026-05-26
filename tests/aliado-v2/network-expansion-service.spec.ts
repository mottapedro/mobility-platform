import bcrypt from "bcrypt";
import { ActorType, ReferralFlowType } from "../../src/shared/enums";
import { prisma } from "../setup";
import { expandNetworkFromInvite, NetworkExpansionError } from "../../src/domain/onboarding/NetworkExpansionService";

async function makeDriver(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email, email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

async function makePassengerNoRoot(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email, email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.passenger.create({
    data: {
      userId: u.id,
      referralCode: `r-${u.id.slice(0, 6)}`,
      publicSlug: `s-${u.id.slice(0, 6)}`,
    },
  });
}

describe("NetworkExpansionService.expandNetworkFromInvite", () => {
  it("D→P: records relationship, assigns rootDriverId, marks invite consumed", async () => {
    const owner = await makeDriver("exp.d2p.owner@test.com");
    const invite = await prisma.invite.create({
      data: {
        slug: "exp-d2p-001",
        ownerActorType: ActorType.DRIVER,
        ownerId: owner.id,
        expectedFlowType: ReferralFlowType.DRIVER_TO_PASSENGER,
        expectedActorType: ActorType.PASSENGER,
      },
    });
    const newcomer = await makePassengerNoRoot("exp.d2p.newcomer@test.com");

    const result = await expandNetworkFromInvite({
      slug: "exp-d2p-001",
      invitedActorType: ActorType.PASSENGER,
      invitedId: newcomer.id,
    });

    expect(result.relationship.inviterId).toBe(owner.id);
    expect(result.relationship.invitedId).toBe(newcomer.id);
    expect(result.relationship.flowType).toBe(ReferralFlowType.DRIVER_TO_PASSENGER);
    expect(result.relationship.rootDriverId).toBe(owner.id);

    const consumed = await prisma.invite.findUnique({ where: { id: invite.id } });
    expect(consumed?.consumedAt).not.toBeNull();
    expect(consumed?.consumedByUserId).toBe(newcomer.userId);

    const updated = await prisma.passenger.findUnique({ where: { id: newcomer.id } });
    expect(updated?.rootDriverId).toBe(owner.id);
  });

  it("rejects when expectedActorType does not match invited actor", async () => {
    const owner = await makeDriver("exp.mismatch.owner@test.com");
    await prisma.invite.create({
      data: {
        slug: "exp-mismatch-001",
        ownerActorType: ActorType.DRIVER,
        ownerId: owner.id,
        expectedFlowType: ReferralFlowType.DRIVER_TO_PASSENGER,
        expectedActorType: ActorType.PASSENGER,
      },
    });
    const otherDriver = await makeDriver("exp.mismatch.other@test.com");

    await expect(
      expandNetworkFromInvite({
        slug: "exp-mismatch-001",
        invitedActorType: ActorType.DRIVER,
        invitedId: otherDriver.id,
      })
    ).rejects.toBeInstanceOf(NetworkExpansionError);
  });

  it("rejects an already-consumed invite", async () => {
    const owner = await makeDriver("exp.dup.owner@test.com");
    await prisma.invite.create({
      data: {
        slug: "exp-dup-001",
        ownerActorType: ActorType.DRIVER,
        ownerId: owner.id,
        expectedFlowType: ReferralFlowType.DRIVER_TO_PASSENGER,
        expectedActorType: ActorType.PASSENGER,
        consumedAt: new Date(),
      },
    });
    const p = await makePassengerNoRoot("exp.dup.p@test.com");
    await expect(
      expandNetworkFromInvite({
        slug: "exp-dup-001",
        invitedActorType: ActorType.PASSENGER,
        invitedId: p.id,
      })
    ).rejects.toThrow(/consumed/i);
  });
});
