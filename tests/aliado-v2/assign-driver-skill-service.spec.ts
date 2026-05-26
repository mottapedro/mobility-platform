import bcrypt from "bcrypt";
import { DomainEventType, DriverSkillCode } from "../../src/shared/enums";
import { prisma } from "../setup";
import { execute as assignDriverSkill } from "../../src/application/services/AssignDriverSkillService";
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

describe("AssignDriverSkillService (application)", () => {
  it("creates a new DriverSkill and reports created=true", async () => {
    const d = await makeDriver("ads.new@test.com");
    const result = await assignDriverSkill({
      driverId: d.id,
      code: DriverSkillCode.COLECIONADOR,
    });

    expect(result.created).toBe(true);
    expect(result.driverSkill.driverId).toBe(d.id);
    expect(result.driverSkill.level).toBe(1);
  });

  it("is idempotent: second call returns same row with created=false", async () => {
    const d = await makeDriver("ads.idem@test.com");
    const first = await assignDriverSkill({
      driverId: d.id,
      code: DriverSkillCode.EXECUTIVO,
    });
    const second = await assignDriverSkill({
      driverId: d.id,
      code: DriverSkillCode.EXECUTIVO,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.driverSkill.id).toBe(first.driverSkill.id);
  });

  it("emits SKILL_ASSIGNED only on first creation (not on idempotent re-call)", async () => {
    const d = await makeDriver("ads.evt@test.com");
    const bus = createEventBus();
    const received: string[] = [];
    bus.subscribe(DomainEventType.SKILL_ASSIGNED, async (event) => {
      received.push(event.aggregateId);
    });

    await assignDriverSkill(
      { driverId: d.id, code: DriverSkillCode.COLECIONADOR },
      { bus }
    );
    await assignDriverSkill(
      { driverId: d.id, code: DriverSkillCode.COLECIONADOR },
      { bus }
    );

    expect(received).toEqual([d.id]);
    const persisted = await prisma.domainEvent.findMany({
      where: { type: DomainEventType.SKILL_ASSIGNED, aggregateId: d.id },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].aggregateType).toBe("Driver");
  });
});
