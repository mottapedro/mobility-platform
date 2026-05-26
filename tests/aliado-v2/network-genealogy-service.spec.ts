import bcrypt from "bcrypt";
import { ActorType, ReferralFlowType } from "../../src/shared/enums";
import { prisma } from "../setup";
import { recordRelationship } from "../../src/domain/referral-network/ReferralRelationshipService";
import { getNetworkRelationships } from "../../src/domain/referral-network/NetworkGenealogyService";

async function makeDriver(email: string) {
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
    data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

async function makePassenger(email: string, referredByDriverId: string) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
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
      referredByDriverId,
    },
  });
}

describe("NetworkGenealogyService — getNetworkRelationships", () => {
  it("returns totals broken down by flow type, ordered by createdAt asc", async () => {
    const root = await makeDriver("gen.root@test.com");
    const d1 = await makeDriver("gen.d1@test.com");
    const p1 = await makePassenger("gen.p1@test.com", root.id);

    await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedActorType: ActorType.DRIVER,
      invitedId: d1.id,
    });
    await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedActorType: ActorType.PASSENGER,
      invitedId: p1.id,
    });

    const result = await getNetworkRelationships(root.id);
    expect(result.driverId).toBe(root.id);
    expect(result.totals.total).toBe(2);
    expect(result.totals.driverToDriver).toBe(1);
    expect(result.totals.driverToPassenger).toBe(1);
    expect(result.totals.passengerToPassenger).toBe(0);
    expect(result.relationships[0].inviter.actorType).toBe(ActorType.DRIVER);
  });

  it("filters by flowType", async () => {
    const root = await makeDriver("gen.f.root@test.com");
    const d1 = await makeDriver("gen.f.d1@test.com");
    const p1 = await makePassenger("gen.f.p1@test.com", root.id);

    await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedActorType: ActorType.DRIVER,
      invitedId: d1.id,
    });
    await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedActorType: ActorType.PASSENGER,
      invitedId: p1.id,
    });

    const filtered = await getNetworkRelationships(root.id, {
      flowType: ReferralFlowType.DRIVER_TO_PASSENGER,
    });
    expect(filtered.totals.total).toBe(1);
    expect(filtered.relationships[0].invited.id).toBe(p1.id);
  });
});
