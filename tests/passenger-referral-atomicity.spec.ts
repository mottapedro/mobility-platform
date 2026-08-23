import request from "supertest";
import bcrypt from "bcrypt";

import { app } from "../src/app";
import { prisma, cleanTestData } from "./setup";
import { ActorType } from "../src/shared/enums";
import * as referralService from "../src/domain/referral-network/ReferralRelationshipService";

async function makeDriver(email: string) {
  const user = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("123456", 4),
    },
  });

  return prisma.driver.create({
    data: {
      userId: user.id,
      isActive: true,
      experienceLevel: "PROFISSIONAL",
      regions: ["ZN"],
      referralCode: `ref-${user.id.slice(0, 8)}`,
      publicSlug: `slug-${user.id.slice(0, 8)}`,
    },
  });
}

async function makePassenger(email: string, referralCode: string) {
  const user = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("123456", 4),
    },
  });

  return prisma.passenger.create({
    data: {
      userId: user.id,
      referralCode,
      publicSlug: referralCode,
      networkLevel: 0,
    },
  });
}

async function findRelationship(invitedId: string) {
  return prisma.referralRelationship.findUnique({
    where: {
      invitedActorType_invitedId: {
        invitedActorType: ActorType.PASSENGER,
        invitedId,
      },
    },
  });
}

beforeEach(cleanTestData);

describe("passenger referral atomicity", () => {
  it("registers João→passenger with Pedro as the canonical root", async () => {
    const pedro = await makeDriver("atomic.pedro@test.com");
    const joao = await makeDriver("atomic.joao@test.com");
    await prisma.driver.update({
      where: { id: joao.id },
      data: { referredByDriverId: pedro.id },
    });

    const response = await request(app).post("/auth/register").send({
      name: "Atomic D2P Passenger",
      email: "atomic.auth.d2p@test.com",
      password: "123456",
      role: "passenger",
      phone: "21988887777",
      referralCode: joao.referralCode,
    });

    expect(response.status).toBe(201);
    const passenger = await prisma.passenger.findUnique({
      where: { id: response.body.passengerId },
    });
    const relationship = await findRelationship(response.body.passengerId);

    expect(passenger?.referredByDriverId).toBe(joao.id);
    expect(passenger?.rootDriverId).toBe(pedro.id);
    expect(relationship).toMatchObject({
      flowType: "DRIVER_TO_PASSENGER",
      inviterActorType: ActorType.DRIVER,
      inviterId: joao.id,
      invitedActorType: ActorType.PASSENGER,
      invitedId: passenger?.id,
      rootDriverId: pedro.id,
      inviterDriverId: joao.id,
    });
  });

  it("registers passenger→passenger with one canonical P2P edge", async () => {
    const pedro = await makeDriver("atomic.p2p.pedro@test.com");
    const inviter = await makePassenger("atomic.p2p.inviter@test.com", "atomic-p2p-inviter");
    await prisma.passenger.update({
      where: { id: inviter.id },
      data: { referredByDriverId: pedro.id, rootDriverId: pedro.id },
    });
    await referralService.recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: pedro.id,
      invitedActorType: ActorType.PASSENGER,
      invitedId: inviter.id,
    });

    const response = await request(app).post("/auth/register").send({
      name: "Atomic P2P Passenger",
      email: "atomic.auth.p2p@test.com",
      password: "123456",
      role: "passenger",
      phone: "21988887778",
      referralCode: inviter.referralCode,
    });

    expect(response.status).toBe(201);
    const passenger = await prisma.passenger.findUnique({
      where: { id: response.body.passengerId },
    });
    const relationship = await findRelationship(response.body.passengerId);

    expect(passenger?.referredByPassengerId).toBe(inviter.id);
    expect(passenger?.rootDriverId).toBe(pedro.id);
    expect(passenger?.networkLevel).toBe(1);
    expect(relationship).toMatchObject({
      flowType: "PASSENGER_TO_PASSENGER",
      inviterActorType: ActorType.PASSENGER,
      inviterId: inviter.id,
      invitedActorType: ActorType.PASSENGER,
      invitedId: passenger?.id,
      rootDriverId: pedro.id,
      inviterDriverId: null,
    });
  });

  it("creates a referred passenger through POST /passengers atomically", async () => {
    const pedro = await makeDriver("atomic.route.pedro@test.com");
    const joao = await makeDriver("atomic.route.joao@test.com");
    await prisma.driver.update({ where: { id: joao.id }, data: { referredByDriverId: pedro.id } });

    const response = await request(app).post("/passengers").send({
      name: "Legacy Controller Passenger",
      email: "atomic.route.passengers@test.com",
      phone: "21988887779",
      referredByDriverId: joao.id,
    });

    expect(response.status).toBe(201);
    const passenger = await prisma.passenger.findFirst({
      where: { user: { email: "atomic.route.passengers@test.com" } },
    });
    const relationship = await findRelationship(passenger!.id);
    expect(passenger?.rootDriverId).toBe(pedro.id);
    expect(relationship?.invitedId).toBe(passenger?.id);
    expect(relationship?.rootDriverId).toBe(pedro.id);
  });

  it("creates a referred passenger through POST /rides/passengers atomically", async () => {
    const pedro = await makeDriver("atomic.ride.pedro@test.com");
    const joao = await makeDriver("atomic.ride.joao@test.com");
    await prisma.driver.update({ where: { id: joao.id }, data: { referredByDriverId: pedro.id } });

    const response = await request(app).post("/rides/passengers").send({
      name: "Legacy Ride Passenger",
      email: "atomic.route.rides@test.com",
      phone: "21988887780",
      referredByDriverId: joao.id,
    });

    expect(response.status).toBe(201);
    const passenger = await prisma.passenger.findFirst({
      where: { user: { email: "atomic.route.rides@test.com" } },
    });
    const relationship = await findRelationship(passenger!.id);
    expect(passenger?.rootDriverId).toBe(pedro.id);
    expect(relationship?.invitedId).toBe(passenger?.id);
    expect(relationship?.rootDriverId).toBe(pedro.id);
  });

  it("rolls back POST /passengers when the canonical relationship fails", async () => {
    const driver = await makeDriver("atomic.rollback.passengers.driver@test.com");
    const spy = jest
      .spyOn(referralService, "recordPassengerReferralRelationship")
      .mockRejectedValueOnce(new Error("forced relationship failure"));

    try {
      const response = await request(app).post("/passengers").send({
        name: "Rollback Passenger",
        email: "atomic.rollback.passengers@test.com",
        phone: "21988887781",
        referredByDriverId: driver.id,
      });

      expect(response.status).toBe(500);
      expect(
        await prisma.user.findUnique({ where: { email: "atomic.rollback.passengers@test.com" } })
      ).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("rolls back /auth/register when the canonical relationship fails", async () => {
    const driver = await makeDriver("atomic.rollback.auth.driver@test.com");
    const spy = jest
      .spyOn(referralService, "recordPassengerReferralRelationship")
      .mockRejectedValueOnce(new Error("forced relationship failure"));

    try {
      const response = await request(app).post("/auth/register").send({
        name: "Rollback Auth Passenger",
        email: "atomic.rollback.auth@test.com",
        password: "123456",
        role: "passenger",
        phone: "21988887782",
        referralCode: driver.referralCode,
      });

      expect(response.status).toBe(500);
      expect(
        await prisma.user.findUnique({ where: { email: "atomic.rollback.auth@test.com" } })
      ).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("rolls back /rides/passengers when the canonical relationship fails", async () => {
    const driver = await makeDriver("atomic.rollback.ride.driver@test.com");
    const spy = jest
      .spyOn(referralService, "recordPassengerReferralRelationship")
      .mockRejectedValueOnce(new Error("forced relationship failure"));

    try {
      const response = await request(app).post("/rides/passengers").send({
        name: "Rollback Ride Passenger",
        email: "atomic.rollback.ride@test.com",
        phone: "21988887783",
        referredByDriverId: driver.id,
      });

      expect(response.status).toBe(500);
      expect(
        await prisma.user.findUnique({ where: { email: "atomic.rollback.ride@test.com" } })
      ).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
