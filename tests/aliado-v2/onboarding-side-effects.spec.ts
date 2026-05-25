import bcrypt from "bcrypt";
import request from "supertest";
import { ActorType, ReferralFlowType } from "../../src/shared/enums";
import { app } from "../../src/app";
import { prisma } from "../setup";

async function makeDriverViaApi(opts: { name: string; email: string; referralCode?: string }) {
  const res = await request(app).post("/auth/register").send({
    name: opts.name,
    email: opts.email,
    password: "123456",
    role: "driver",
    phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
    ...(opts.referralCode ? { referralCode: opts.referralCode } : {}),
    regions: ["ZN"],
  });
  expect(res.status).toBe(201);
  return res.body as { driverId: string; referralCode: string };
}

async function makePassengerViaApi(opts: { name: string; email: string; referralCode: string }) {
  const res = await request(app).post("/auth/register").send({
    name: opts.name,
    email: opts.email,
    password: "123456",
    role: "passenger",
    phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
    referralCode: opts.referralCode,
  });
  expect(res.status).toBe(201);
  return res.body as { passengerId: string };
}

describe("Onboarding side effects — DriverReferral + ReferralRelationship", () => {
  // seed a root driver directly to avoid the V2 onboarding writing into Pedro's tree
  let rootDriverId: string;
  let rootReferralCode: string;

  beforeEach(async () => {
    const u = await prisma.user.create({
      data: {
        name: "Side Root",
        email: "side.root@test.com",
        phone: "21900008888",
        role: "DRIVER",
        passwordHash: await bcrypt.hash("x", 4),
      },
    });
    const d = await prisma.driver.create({
      data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
    });
    rootDriverId = d.id;
    rootReferralCode = d.referralCode;
  });

  it("driver onboarding writes BOTH DriverReferral AND ReferralRelationship", async () => {
    const invited = await makeDriverViaApi({
      name: "Side Invited",
      email: "side.invited@test.com",
      referralCode: rootReferralCode,
    });

    // legacy closure must exist
    const closure = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: rootDriverId, referredDriverId: invited.driverId, level: 1 },
    });
    expect(closure).not.toBeNull();

    // V2 graph must exist
    const rel = await prisma.referralRelationship.findUnique({
      where: {
        invitedActorType_invitedId: {
          invitedActorType: ActorType.DRIVER,
          invitedId: invited.driverId,
        },
      },
    });
    expect(rel).not.toBeNull();
    expect(rel!.flowType).toBe(ReferralFlowType.DRIVER_TO_DRIVER);
    expect(rel!.inviterDriverId).toBe(rootDriverId);
    expect(rel!.rootDriverId).toBe(rootDriverId);
  });

  it("passenger onboarding under a driver sets rootDriverId + DRIVER_TO_PASSENGER relationship", async () => {
    const pax = await makePassengerViaApi({
      name: "Side Pax",
      email: "side.pax@test.com",
      referralCode: rootReferralCode,
    });

    const passenger = await prisma.passenger.findUnique({
      where: { id: pax.passengerId },
      select: { rootDriverId: true, referredByDriverId: true },
    });
    expect(passenger?.referredByDriverId).toBe(rootDriverId);
    expect(passenger?.rootDriverId).toBe(rootDriverId);

    const rel = await prisma.referralRelationship.findUnique({
      where: {
        invitedActorType_invitedId: {
          invitedActorType: ActorType.PASSENGER,
          invitedId: pax.passengerId,
        },
      },
    });
    expect(rel).not.toBeNull();
    expect(rel!.flowType).toBe(ReferralFlowType.DRIVER_TO_PASSENGER);
    expect(rel!.rootDriverId).toBe(rootDriverId);
  });
});
