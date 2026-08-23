import request from "supertest";
import bcrypt from "bcrypt";

import { app } from "../src/app";
import { prisma } from "./setup";
import { ActorType } from "../src/shared/enums";
import { recordRelationship } from "../src/domain/referral-network/ReferralRelationshipService";

async function createDriverWithRegion(params: {
  name: string;
  email: string;
  region: string;
}) {
  const user = await prisma.user.create({
    data: {
      name: params.name,
      email: params.email,
      phone: `219${Math.floor(Math.random() * 100000000)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("123456", 10),
    },
  });

  return prisma.driver.create({
    data: {
      userId: user.id,
      isActive: true,
      experienceLevel: "INTERMEDIARIO",
      regions: [params.region],
    },
  });
}

describe("POST /auth/register with referralCode", () => {
  it("creates a referred driver linked to the referrer", async () => {
    const referrer = await createDriverWithRegion({
      name: "Carlos Silva",
      email: "carlos.driver@test.com",
      region: "ZS",
    });

    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Marcos Lima",
        email: "marcos.driver@test.com",
        password: "123456",
        role: "driver",
        phone: "21988887777",
        referralCode: referrer.referralCode,
        regions: ["ZN"],
      });

    expect(response.status).toBe(201);
    expect(response.body.driverId).toBeDefined();

    const driver = await prisma.driver.findUnique({
      where: {
        id: response.body.driverId,
      },
    });

    expect(driver).not.toBeNull();
    expect(driver?.referredByDriverId).toBe(referrer.id);
  });

  it("creates a passenger linked to the resolved driver", async () => {
    const driver = await createDriverWithRegion({
      name: "Paula Motorista",
      email: "paula.motorista@test.com",
      region: "ZN",
    });

    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Ana Passageira",
        email: "ana.passageira@test.com",
        password: "123456",
        role: "passenger",
        phone: "21999990001",
        referralCode: driver.referralCode,
      });

    expect(response.status).toBe(201);
    expect(response.body.passengerId).toBeDefined();

    const passenger = await prisma.passenger.findUnique({
      where: {
        id: response.body.passengerId,
      },
    });

    expect(passenger).not.toBeNull();
    expect(passenger?.referredByDriverId).toBe(driver.id);
  });

  it("returns 400 when referralCode is invalid", async () => {
    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Bruno Sem Referral",
        email: "bruno.sem.referral@test.com",
        password: "123456",
        role: "passenger",
        phone: "21999990002",
        referralCode: "codigo-invalido",
      });

    expect(response.status).toBe(400);
  });
});

describe("POST /auth/register — passenger referralCode", () => {
  it("links referredByPassengerId when passenger referralCode is valid", async () => {
    const rootDriver = await createDriverWithRegion({
      name: "P2P Root Driver",
      email: "p2p-root-driver@test.com",
      region: "ZN",
    });

    await prisma.passenger.deleteMany({
      where: {
        user: {
          email: {
            in: [
              "referrer-passenger@test.com",
              "new-passenger@test.com",
            ],
          },
        },
      },
    });

    await prisma.user.deleteMany({
      where: {
        email: {
          in: [
            "referrer-passenger@test.com",
            "new-passenger@test.com",
          ],
        },
      },
    });

    const referrerUser = await prisma.user.create({
      data: {
        name: "Referrer Passenger",
        email: "referrer-passenger@test.com",
        phone: "11999999999",
        role: "PASSENGER",
        passenger: {
          create: {
            referralCode: "pass-ref-code",
            publicSlug: "referrer-passenger",
            referredByDriver: { connect: { id: rootDriver.id } },
            rootDriverId: rootDriver.id,
          },
        },
      },
      include: {
        passenger: true,
      },
    });

    expect(referrerUser.passenger).not.toBeNull();
    await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: rootDriver.id,
      invitedActorType: ActorType.PASSENGER,
      invitedId: referrerUser.passenger!.id,
    });

    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "New Passenger",
        email: "new-passenger@test.com",
        password: "123456",
        role: "passenger",
        phone: "11988888888",
        referralCode: "pass-ref-code",
      });

    expect(response.status).toBe(201);
    expect(response.body.passengerId).toBeDefined();

    const passenger = await prisma.passenger.findUnique({
      where: {
        id: response.body.passengerId,
      },
    });

    expect(passenger).not.toBeNull();
    expect(passenger?.referredByPassengerId).toBe(
      referrerUser.passenger?.id,
    );
  });

  it("returns non-null referralCode and publicSlug for every passenger", async () => {
    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Maria Fernanda",
        email: "maria.identity@test.com",
        password: "123456",
        role: "passenger",
        phone: "11977777777",
      });

    expect(response.status).toBe(201);
    expect(response.body.passengerId).toBeDefined();

    const passenger = await prisma.passenger.findUnique({
      where: {
        id: response.body.passengerId,
      },
    });

    expect(passenger).not.toBeNull();

    expect(passenger?.referralCode).toBeDefined();
    expect(typeof passenger?.referralCode).toBe("string");
    expect(passenger?.referralCode).not.toBe("");

    expect(passenger?.publicSlug).toBeDefined();
    expect(typeof passenger?.publicSlug).toBe("string");
    expect(passenger?.publicSlug).not.toBe("");

    expect(passenger?.publicSlug).toMatch(/^maria-fernanda/);
  });
});
