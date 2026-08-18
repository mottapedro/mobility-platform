import bcrypt from "bcrypt";
import { ActorType, ReferralFlowType } from "../../src/shared/enums";
import { prisma } from "../setup";
import { resolveOnboardingContext } from "../../src/domain/onboarding/OnboardingContextService";
import { recordRelationship } from "../../src/domain/referral-network/ReferralRelationshipService";

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
    data: {
      userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"],
      publicSlug: `dslug-${u.id.slice(0, 6)}`,
    },
  });
}

async function makePassenger(email: string, rootDriverId: string) {
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
      referralCode: `pcode-${u.id.slice(0, 6)}`,
      publicSlug: `pslug-${u.id.slice(0, 6)}`,
      rootDriverId,
    },
  });
}

describe("OnboardingContextService.resolveOnboardingContext", () => {
  it("resolves a DRIVER invite slug → D2D context with inviter driver and root=self", async () => {
    const owner = await makeDriver("onb.invite.d2d@test.com");
    await prisma.invite.create({
      data: {
        slug: "join-d2d-001",
        ownerActorType: ActorType.DRIVER,
        ownerId: owner.id,
        expectedFlowType: ReferralFlowType.DRIVER_TO_DRIVER,
        expectedActorType: ActorType.DRIVER,
      },
    });

    const ctx = await resolveOnboardingContext("join-d2d-001");

    expect(ctx.source).toBe("invite");
    expect(ctx.slug).toBe("join-d2d-001");
    expect(ctx.flowType).toBe(ReferralFlowType.DRIVER_TO_DRIVER);
    expect(ctx.expectedActor).toBe(ActorType.DRIVER);
    expect(ctx.inviter).toMatchObject({ actorType: ActorType.DRIVER, id: owner.id });
    expect(ctx.rootDriver).toMatchObject({ id: owner.id });
    expect(ctx.invite).toEqual({
      code: "join-d2d-001",
      displayLabel: "Convite de onb.invite.d2d@test.com",
      inviter: {
        actorType: ActorType.DRIVER,
        id: owner.id,
        name: "onb.invite.d2d@test.com",
      },
    });
    expect(ctx.lineage).toBeNull();
    expect(ctx.ownership).toMatchObject({ driverId: owner.id });
  });

  it("resolves a PASSENGER invite (P2P) — inviter passenger, root inherited", async () => {
    const root = await makeDriver("onb.invite.p2p.root@test.com");
    const inviter = await makePassenger("onb.invite.p2p.inviter@test.com", root.id);
    await recordRelationship({
      inviterActorType: ActorType.DRIVER, inviterId: root.id,
      invitedActorType: ActorType.PASSENGER, invitedId: inviter.id,
    });
    await prisma.invite.create({
      data: {
        slug: "join-p2p-002",
        ownerActorType: ActorType.PASSENGER,
        ownerId: inviter.id,
        expectedFlowType: ReferralFlowType.PASSENGER_TO_PASSENGER,
        expectedActorType: ActorType.PASSENGER,
      },
    });

    const ctx = await resolveOnboardingContext("join-p2p-002");

    expect(ctx.flowType).toBe(ReferralFlowType.PASSENGER_TO_PASSENGER);
    expect(ctx.expectedActor).toBe(ActorType.PASSENGER);
    expect(ctx.inviter).toMatchObject({ actorType: ActorType.PASSENGER, id: inviter.id });
    expect(ctx.rootDriver?.id).toBe(root.id);
    expect(ctx.invite).toEqual({
      code: "join-p2p-002",
      displayLabel: "Convite de onb.invite.p2p.inviter@test.com",
      inviter: {
        actorType: ActorType.PASSENGER,
        id: inviter.id,
        name: "onb.invite.p2p.inviter@test.com",
      },
    });
    expect(ctx.lineage?.passengerId).toBe(inviter.id);
    expect(ctx.lineage?.rootDriverId).toBe(root.id);
  });

  it("falls back to Driver.referralCode when no invite matches", async () => {
    const d = await makeDriver("onb.code.driver@test.com");
    const driver = await prisma.driver.findUnique({ where: { id: d.id } });
    const ctx = await resolveOnboardingContext(driver!.referralCode);
    expect(ctx.source).toBe("driver_referral_code");
    expect(ctx.inviter).toMatchObject({ actorType: ActorType.DRIVER, id: d.id });
    expect(ctx.flowType).toBe(ReferralFlowType.DRIVER_TO_PASSENGER);
    expect(ctx.expectedActor).toBe(ActorType.PASSENGER);
    expect(ctx.rootDriver?.id).toBe(d.id);
    expect(ctx.invite).toEqual({
      code: driver!.referralCode,
      displayLabel: "Convite de onb.code.driver@test.com",
      inviter: {
        actorType: ActorType.DRIVER,
        id: d.id,
        name: "onb.code.driver@test.com",
      },
    });
  });

  it("falls back to Driver.publicSlug", async () => {
    const d = await makeDriver("onb.slug.driver@test.com");
    const driver = await prisma.driver.findUnique({ where: { id: d.id } });
    const ctx = await resolveOnboardingContext(driver!.publicSlug!);
    expect(ctx.source).toBe("driver_public_slug");
    expect(ctx.inviter).toMatchObject({ actorType: ActorType.DRIVER, id: d.id });
  });

  it("falls back to Passenger.referralCode → P2P inheriting rootDriver", async () => {
    const root = await makeDriver("onb.pcode.root@test.com");
    const p = await makePassenger("onb.pcode.p@test.com", root.id);
    await recordRelationship({
      inviterActorType: ActorType.DRIVER, inviterId: root.id,
      invitedActorType: ActorType.PASSENGER, invitedId: p.id,
    });
    const ctx = await resolveOnboardingContext(p.referralCode!);
    expect(ctx.source).toBe("passenger_referral_code");
    expect(ctx.inviter).toMatchObject({ actorType: ActorType.PASSENGER, id: p.id });
    expect(ctx.rootDriver?.id).toBe(root.id);
    expect(ctx.flowType).toBe(ReferralFlowType.PASSENGER_TO_PASSENGER);
    expect(ctx.lineage?.passengerId).toBe(p.id);
  });

  it("rejects an expired invite", async () => {
    const owner = await makeDriver("onb.expired@test.com");
    await prisma.invite.create({
      data: {
        slug: "expired-slug",
        ownerActorType: ActorType.DRIVER,
        ownerId: owner.id,
        expectedFlowType: ReferralFlowType.DRIVER_TO_PASSENGER,
        expectedActorType: ActorType.PASSENGER,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await expect(resolveOnboardingContext("expired-slug")).rejects.toThrow(/expired/i);
  });

  it("rejects an already-consumed invite", async () => {
    const owner = await makeDriver("onb.consumed@test.com");
    await prisma.invite.create({
      data: {
        slug: "consumed-slug",
        ownerActorType: ActorType.DRIVER,
        ownerId: owner.id,
        expectedFlowType: ReferralFlowType.DRIVER_TO_PASSENGER,
        expectedActorType: ActorType.PASSENGER,
        consumedAt: new Date(),
      },
    });
    await expect(resolveOnboardingContext("consumed-slug")).rejects.toThrow(/consumed/i);
  });

  it("throws when slug/code matches nothing", async () => {
    await expect(resolveOnboardingContext("no-such-slug-xyz")).rejects.toThrow(/not found/i);
  });
});
