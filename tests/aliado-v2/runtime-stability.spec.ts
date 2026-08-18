import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../../src/app";
import { prisma } from "../setup";
import { ActorType, DomainEventType } from "../../src/shared/enums";
import { createDriverReferralChain } from "../../src/domain/services/DriverReferralService";
import { recordRelationship } from "../../src/domain/referral-network/ReferralRelationshipService";
import { SyncProjectionJob } from "../../src/domain/network/SyncProjectionJob";
import { createEventBus, recordAndPublish } from "../../src/domain/shared/events/EventBus";

const hash = (pw: string) => bcrypt.hash(pw, 4);

async function makeDriver(
  tag: string,
  password: string,
  referredByDriverId?: string
): Promise<{ id: string; email: string; password: string }> {
  const email = `runtime.driver.${tag}@auth.com`;
  const user = await prisma.user.create({
    data: {
      name: `Runtime Driver ${tag}`,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await hash(password),
    },
  });

  const driver = await prisma.driver.create({
    data: {
      userId: user.id,
      isActive: true,
      experienceLevel: "PROFISSIONAL",
      regions: ["ZN"],
      referralCode: `runtime-rc-${tag}`,
      publicSlug: `runtime-slug-${tag}`,
      referredByDriverId: referredByDriverId ?? null,
    },
  });

  if (referredByDriverId) {
    await createDriverReferralChain(driver.id, referredByDriverId, prisma);
    await recordRelationship(
      {
        inviterActorType: ActorType.DRIVER,
        inviterId: referredByDriverId,
        invitedActorType: ActorType.DRIVER,
        invitedId: driver.id,
      },
      prisma
    );
  }

  return { id: driver.id, email, password };
}

function canonicalContext(body: any): string {
  return JSON.stringify({
    flowType: body.flowType,
    targetActorExpected: body.targetActorExpected,
    rootDriverId: body.rootDriver?.id ?? null,
    ancestors: body.genealogy?.ancestors?.map((x: any) => x.id) ?? [],
    lateral: body.genealogy?.lateral?.map((x: any) => x.id) ?? [],
    descendants: body.genealogy?.descendants ?? [],
    networkMetrics: body.networkMetrics,
  });
}

describe("runtime stability governance", () => {
  it("relogin keeps network context immutable for same driver", async () => {
    const root = await makeDriver(`root-${Date.now()}`, "123456");
    const child = await makeDriver(`child-${Date.now()}`, "123456", root.id);

    const login1 = await request(app)
      .post("/auth/login")
      .send({ email: child.email, password: child.password })
      .expect(200);

    const ctx1 = await request(app)
      .get(`/network/context?actorId=${login1.body.driverId}&actorType=DRIVER`)
      .expect(200);

    const login2 = await request(app)
      .post("/auth/login")
      .send({ email: child.email, password: child.password })
      .expect(200);

    const ctx2 = await request(app)
      .get(`/network/context?actorId=${login2.body.driverId}&actorType=DRIVER`)
      .expect(200);

    expect(canonicalContext(ctx1.body)).toBe(canonicalContext(ctx2.body));
  });

  it("polling/hydration returns stable projection snapshots", async () => {
    const root = await makeDriver(`poll-root-${Date.now()}`, "123456");
    const child = await makeDriver(`poll-child-${Date.now()}`, "123456", root.id);
    await makeDriver(`poll-grand-${Date.now()}`, "123456", child.id);

    const snapshots: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .get(`/network/context?actorId=${root.id}&actorType=DRIVER`)
        .expect(200);
      snapshots.push(canonicalContext(res.body));
    }

    for (const snap of snapshots) {
      expect(snap).toBe(snapshots[0]);
    }
  });

  it("rebuild projection via SyncProjectionJob preserves topology", async () => {
    const root = await makeDriver(`sync-root-${Date.now()}`, "123456");
    const child = await makeDriver(`sync-child-${Date.now()}`, "123456", root.id);

    const before = await request(app)
      .get(`/network/context?actorId=${root.id}&actorType=DRIVER`)
      .expect(200);

    await prisma.referralRelationship.deleteMany({
      where: {
        invitedActorType: "DRIVER",
        invitedId: child.id,
      },
    });

    const sync = await SyncProjectionJob.execute(prisma);
    expect(sync.repaired).toBeGreaterThanOrEqual(1);

    const after = await request(app)
      .get(`/network/context?actorId=${root.id}&actorType=DRIVER`)
      .expect(200);

    expect(canonicalContext(after.body)).toBe(canonicalContext(before.body));
  });

  it("event replay is deterministic from persisted DomainEvent log", async () => {
    const aggregateType = "GovernanceReplayTest";
    const aggregateId = `agg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    const bus = createEventBus();
    const liveSeq: string[] = [];

    for (const type of [
      DomainEventType.LINEAGE_RESOLVED,
      DomainEventType.SKILL_ASSIGNED,
      DomainEventType.RIDE_FINALIZED,
    ]) {
      bus.subscribe(type, async (event) => {
        liveSeq.push(`${event.type}:${event.aggregateType}:${event.aggregateId}`);
      });
    }

    await recordAndPublish(bus, {
      type: DomainEventType.LINEAGE_RESOLVED,
      aggregateType,
      aggregateId,
      payload: { step: 1 },
    });
    await recordAndPublish(bus, {
      type: DomainEventType.SKILL_ASSIGNED,
      aggregateType,
      aggregateId,
      payload: { step: 2 },
    });
    await recordAndPublish(bus, {
      type: DomainEventType.RIDE_FINALIZED,
      aggregateType,
      aggregateId,
      payload: { step: 3 },
    });

    const rows = await prisma.domainEvent.findMany({
      where: { aggregateType, aggregateId },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      select: {
        type: true,
        aggregateType: true,
        aggregateId: true,
        payload: true,
      },
    });

    const replayBus = createEventBus();
    const replaySeq: string[] = [];
    for (const type of [
      DomainEventType.LINEAGE_RESOLVED,
      DomainEventType.SKILL_ASSIGNED,
      DomainEventType.RIDE_FINALIZED,
    ]) {
      replayBus.subscribe(type, async (event) => {
        replaySeq.push(`${event.type}:${event.aggregateType}:${event.aggregateId}`);
      });
    }

    for (const row of rows) {
      await replayBus.publish({
        type: row.type,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        payload: row.payload as any,
      });
    }

    expect(replaySeq).toEqual(liveSeq);

    await prisma.domainEvent.deleteMany({ where: { aggregateType, aggregateId } });
  });
});
