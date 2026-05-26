import bcrypt from "bcrypt";
import { ActorType, DomainEventType } from "../../src/shared/enums";
import { prisma } from "../setup";
import { execute as resolveRootDriver } from "../../src/application/services/ResolveRootDriverService";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { createDriverReferralChain } from "../../src/domain/services/DriverReferralService";

async function makeDriver(name: string, email: string) {
  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: user.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

describe("ResolveRootDriverService (application)", () => {
  it("returns the driver as its own root when no upstream exists", async () => {
    const driver = await makeDriver("App Root A", "app.root.a@test.com");

    const result = await resolveRootDriver({
      actorType: ActorType.DRIVER,
      actorId: driver.id,
    });

    expect(result).toEqual({
      actorType: ActorType.DRIVER,
      actorId: driver.id,
      rootDriverId: driver.id,
    });
  });

  it("resolves the deepest ancestor across a referral chain", async () => {
    const root = await makeDriver("App Root B", "app.root.b@test.com");
    const mid = await makeDriver("App Mid B", "app.mid.b@test.com");
    const leaf = await makeDriver("App Leaf B", "app.leaf.b@test.com");

    await prisma.driver.update({ where: { id: mid.id }, data: { referredByDriverId: root.id } });
    await prisma.driver.update({ where: { id: leaf.id }, data: { referredByDriverId: mid.id } });
    await createDriverReferralChain(mid.id, root.id);
    await createDriverReferralChain(leaf.id, mid.id);

    const result = await resolveRootDriver({
      actorType: ActorType.DRIVER,
      actorId: leaf.id,
    });

    expect(result.rootDriverId).toBe(root.id);
  });

  it("emits LINEAGE_RESOLVED with the resolved rootDriverId when a bus is provided", async () => {
    const driver = await makeDriver("App Root C", "app.root.c@test.com");
    const bus = createEventBus();
    const received: Array<{ type: DomainEventType; aggregateId: string; payload: unknown }> = [];
    bus.subscribe(DomainEventType.LINEAGE_RESOLVED, async (event) => {
      received.push({
        type: event.type,
        aggregateId: event.aggregateId,
        payload: event.payload,
      });
    });

    const result = await resolveRootDriver(
      { actorType: ActorType.DRIVER, actorId: driver.id },
      { bus }
    );

    expect(received).toHaveLength(1);
    expect(received[0].aggregateId).toBe(driver.id);
    expect(result.rootDriverId).toBe(driver.id);

    const persisted = await prisma.domainEvent.findMany({
      where: { type: DomainEventType.LINEAGE_RESOLVED, aggregateId: driver.id },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].aggregateType).toBe("Driver");
  });

  it("does NOT emit any DomainEvent when no bus is provided", async () => {
    const driver = await makeDriver("App Root D", "app.root.d@test.com");

    const before = await prisma.domainEvent.count({
      where: { type: DomainEventType.LINEAGE_RESOLVED, aggregateId: driver.id },
    });
    await resolveRootDriver({ actorType: ActorType.DRIVER, actorId: driver.id });
    const after = await prisma.domainEvent.count({
      where: { type: DomainEventType.LINEAGE_RESOLVED, aggregateId: driver.id },
    });

    expect(after).toBe(before);
  });
});
