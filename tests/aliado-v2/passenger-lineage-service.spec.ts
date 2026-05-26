import bcrypt from "bcrypt";
import { ActorType, ReferralFlowType } from "../../src/shared/enums";
import { prisma } from "../setup";
import { recordRelationship } from "../../src/domain/referral-network/ReferralRelationshipService";
import { getPassengerLineage } from "../../src/domain/referral-network/PassengerLineageService";

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

async function makePassenger(email: string, rootDriverId: string | null) {
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
      rootDriverId: rootDriverId ?? undefined,
    },
  });
}

describe("PassengerLineageService.getPassengerLineage", () => {
  it("D→P: returns root driver + 1 ancestor (the driver) + lineagePath of length 2", async () => {
    const root = await makeDriver("lin.d2p.root@test.com");
    const passenger = await makePassenger("lin.d2p.passenger@test.com", root.id);
    await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedActorType: ActorType.PASSENGER,
      invitedId: passenger.id,
    });

    const lineage = await getPassengerLineage(passenger.id);

    expect(lineage.passengerId).toBe(passenger.id);
    expect(lineage.rootDriverId).toBe(root.id);
    expect(lineage.flowType).toBe(ReferralFlowType.DRIVER_TO_PASSENGER);
    expect(lineage.ancestors).toHaveLength(1);
    expect(lineage.ancestors[0]).toMatchObject({ actorType: ActorType.DRIVER, id: root.id, level: 1 });
    expect(lineage.lineagePath).toEqual([`DRIVER:${root.id}`, `PASSENGER:${passenger.id}`]);
  });

  it("P→P chain: walks back through passenger ancestors up to the root driver", async () => {
    const root = await makeDriver("lin.p2p.root@test.com");
    const p1 = await makePassenger("lin.p2p.p1@test.com", root.id);
    const p2 = await makePassenger("lin.p2p.p2@test.com", root.id);
    const p3 = await makePassenger("lin.p2p.p3@test.com", root.id);

    await recordRelationship({
      inviterActorType: ActorType.DRIVER, inviterId: root.id,
      invitedActorType: ActorType.PASSENGER, invitedId: p1.id,
    });
    await recordRelationship({
      inviterActorType: ActorType.PASSENGER, inviterId: p1.id,
      invitedActorType: ActorType.PASSENGER, invitedId: p2.id,
    });
    await recordRelationship({
      inviterActorType: ActorType.PASSENGER, inviterId: p2.id,
      invitedActorType: ActorType.PASSENGER, invitedId: p3.id,
    });

    const lineage = await getPassengerLineage(p3.id);

    expect(lineage.rootDriverId).toBe(root.id);
    expect(lineage.flowType).toBe(ReferralFlowType.PASSENGER_TO_PASSENGER);
    expect(lineage.ancestors.map((a) => `${a.actorType}:${a.id}`)).toEqual([
      `PASSENGER:${p2.id}`,
      `PASSENGER:${p1.id}`,
      `DRIVER:${root.id}`,
    ]);
    expect(lineage.ancestors.map((a) => a.level)).toEqual([1, 2, 3]);
    expect(lineage.lineagePath).toEqual([
      `DRIVER:${root.id}`,
      `PASSENGER:${p1.id}`,
      `PASSENGER:${p2.id}`,
      `PASSENGER:${p3.id}`,
    ]);
  });

  it("returns ancestors=[] and rootDriverId from Passenger when no relationship row exists", async () => {
    const root = await makeDriver("lin.bare.root@test.com");
    const passenger = await makePassenger("lin.bare.passenger@test.com", root.id);

    const lineage = await getPassengerLineage(passenger.id);

    expect(lineage.passengerId).toBe(passenger.id);
    expect(lineage.rootDriverId).toBe(root.id);
    expect(lineage.flowType).toBeNull();
    expect(lineage.ancestors).toHaveLength(0);
    expect(lineage.lineagePath).toEqual([`DRIVER:${root.id}`, `PASSENGER:${passenger.id}`]);
  });

  it("throws on unknown passenger", async () => {
    await expect(
      getPassengerLineage("00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow();
  });

  it("guards against cycles by capping walk depth", async () => {
    const root = await makeDriver("lin.cycle.root@test.com");
    const passenger = await makePassenger("lin.cycle.passenger@test.com", root.id);
    // Manually insert a self-referencing P2P row to simulate corrupted data.
    await prisma.referralRelationship.create({
      data: {
        flowType: ReferralFlowType.PASSENGER_TO_PASSENGER,
        inviterActorType: ActorType.PASSENGER,
        inviterId: passenger.id,
        invitedActorType: ActorType.PASSENGER,
        invitedId: passenger.id,
        rootDriverId: root.id,
      },
    });

    await expect(getPassengerLineage(passenger.id)).rejects.toThrow(/cycle|depth/i);
  });
});
