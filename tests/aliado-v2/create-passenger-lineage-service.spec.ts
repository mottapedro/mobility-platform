import bcrypt from "bcrypt";
import { ActorType, DomainEventType, ReferralFlowType } from "../../src/shared/enums";
import { prisma } from "../setup";
import { execute as createPassengerLineage } from "../../src/application/services/CreatePassengerLineageService";
import { createEventBus } from "../../src/domain/shared/events/EventBus";

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

describe("CreatePassengerLineageService (application)", () => {
  it("creates the D→P relationship and returns the materialized lineage", async () => {
    const root = await makeDriver("cpl.d2p.root@test.com");
    const passenger = await makePassenger("cpl.d2p.passenger@test.com", root.id);

    const result = await createPassengerLineage({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedPassengerId: passenger.id,
    });

    expect(result.relationship.invitedId).toBe(passenger.id);
    expect(result.relationship.inviterId).toBe(root.id);
    expect(result.relationship.flowType).toBe(ReferralFlowType.DRIVER_TO_PASSENGER);
    expect(result.relationship.rootDriverId).toBe(root.id);

    expect(result.lineage.rootDriverId).toBe(root.id);
    expect(result.lineage.flowType).toBe(ReferralFlowType.DRIVER_TO_PASSENGER);
    expect(result.lineage.ancestors).toHaveLength(1);
    expect(result.lineage.lineagePath).toEqual([
      `DRIVER:${root.id}`,
      `PASSENGER:${passenger.id}`,
    ]);
  });

  it("is idempotent: a second call returns the same ReferralRelationship row", async () => {
    const root = await makeDriver("cpl.idem.root@test.com");
    const passenger = await makePassenger("cpl.idem.passenger@test.com", root.id);

    const first = await createPassengerLineage({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedPassengerId: passenger.id,
    });
    const second = await createPassengerLineage({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedPassengerId: passenger.id,
    });

    expect(second.relationship.id).toBe(first.relationship.id);
    const count = await prisma.referralRelationship.count({
      where: { invitedActorType: ActorType.PASSENGER, invitedId: passenger.id },
    });
    expect(count).toBe(1);
  });

  it("emits LINEAGE_RESOLVED with lineage summary when a bus is provided", async () => {
    const root = await makeDriver("cpl.evt.root@test.com");
    const p1 = await makePassenger("cpl.evt.p1@test.com", root.id);
    const p2 = await makePassenger("cpl.evt.p2@test.com", root.id);
    await createPassengerLineage({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedPassengerId: p1.id,
    });

    const bus = createEventBus();
    const received: Array<{ type: DomainEventType; aggregateId: string; payload: any }> = [];
    bus.subscribe(DomainEventType.LINEAGE_RESOLVED, async (event) => {
      received.push({
        type: event.type,
        aggregateId: event.aggregateId,
        payload: event.payload,
      });
    });

    const result = await createPassengerLineage(
      {
        inviterActorType: ActorType.PASSENGER,
        inviterId: p1.id,
        invitedPassengerId: p2.id,
      },
      { bus }
    );

    expect(received).toHaveLength(1);
    expect(received[0].aggregateId).toBe(p2.id);
    expect(received[0].payload.rootDriverId).toBe(root.id);
    expect(received[0].payload.ancestorCount).toBe(result.lineage.ancestors.length);

    const persisted = await prisma.domainEvent.findMany({
      where: { type: DomainEventType.LINEAGE_RESOLVED, aggregateId: p2.id },
    });
    expect(persisted).toHaveLength(1);
  });

  it("rejects self-referral", async () => {
    const root = await makeDriver("cpl.self.root@test.com");
    const passenger = await makePassenger("cpl.self.passenger@test.com", root.id);

    await expect(
      createPassengerLineage({
        inviterActorType: ActorType.PASSENGER,
        inviterId: passenger.id,
        invitedPassengerId: passenger.id,
      })
    ).rejects.toThrow(/self-referral/i);
  });
});
