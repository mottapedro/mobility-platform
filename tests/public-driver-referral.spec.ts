import request from "supertest";

import { app } from "../src/app";
import { prisma } from "./setup";

describe("Public driver referral flow", () => {
  it("returns public driver data by referralCode", async () => {
    const user = await prisma.user.create({
      data: {
        name: "Pedro Publico",
        email: "pedro-public@test.com",
        phone: "11999990011",
        role: "DRIVER",
      },
    });

    const driver = await prisma.driver.create({
      data: {
        userId: user.id,
        isActive: true,
        experienceLevel: "PROFISSIONAL",
        referralCode: "pedro-publico",
        regions: {
          create: [{ region: "ZN" }],
        },
        vehicles: {
          create: [{ brand: "Chevrolet", model: "Onix", plate: "PUB1234", category: "CONFORTO" }],
        },
      },
    });

    const response = await request(app).get(`/public/drivers/${driver.referralCode}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      name: "Pedro Publico",
      referralCode: "pedro-publico",
      experienceLevel: "PROFISSIONAL",
      memberSince: expect.any(String),
      regions: ["ZN"],
      vehicles: [
        {
          brand: "Chevrolet",
          model: "Onix",
          category: "CONFORTO",
        },
      ],
    });
    expect(response.body.driverId).toBeUndefined();
  });

  it("returns 404 for an unknown public referralCode", async () => {
    const response = await request(app).get("/public/drivers/missing-code");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Motorista não encontrado" });
  });

  it("resolves canonical public route /r/:slug to a valid referralCode", async () => {
    const user = await prisma.user.create({
      data: {
        name: "Pedro Paulo Motta",
        email: "pedro-slug@test.com",
        phone: "11999990020",
        role: "DRIVER",
      },
    });

    await prisma.driver.create({
      data: {
        userId: user.id,
        isActive: true,
        experienceLevel: "PROFISSIONAL",
        referralCode: "pedro-paulo-motta",
      },
    });

    const response = await request(app).get("/r/pedro-paulo-motta");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      slug: "pedro-paulo-motta",
      referralCode: "pedro-paulo-motta",
      driver: {
        id: expect.any(String),
        name: "Pedro Paulo Motta",
        experienceLevel: "PROFISSIONAL",
        memberSince: expect.any(String),
      },
    });
  });

  it("returns 404 for an inactive driver public referralCode", async () => {
    const user = await prisma.user.create({
      data: {
        name: "Inactive Driver",
        email: "inactive-driver@test.com",
        phone: "11999990016",
        role: "DRIVER",
      },
    });

    await prisma.driver.create({
      data: {
        userId: user.id,
        isActive: false,
        experienceLevel: "INTERMEDIARIO",
        referralCode: "inactive-driver-code",
      },
    });

    const response = await request(app).get("/public/drivers/inactive-driver-code");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Motorista não encontrado" });
  });

  it("registers a passenger via referralCode and persists referredByDriverId", async () => {
    const referrerUser = await prisma.user.create({
      data: {
        name: "Referrer Passenger Flow",
        email: "ref-pass@test.com",
        phone: "11999990012",
        role: "DRIVER",
      },
    });

    const referrerDriver = await prisma.driver.create({
      data: {
        userId: referrerUser.id,
        isActive: true,
        experienceLevel: "INTERMEDIARIO",
        referralCode: "passenger-flow-code",
      },
    });

    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Passenger Referral",
        email: "passenger-referral@test.com",
        password: "123456",
        role: "passenger",
        phone: "11999990013",
        referralCode: "passenger-flow-code",
      });

    expect(response.status).toBe(201);
    expect(response.body.referredByDriverId).toBe(referrerDriver.id);

    const passenger = await prisma.passenger.findUnique({
      where: { id: response.body.passengerId },
    });

    expect(passenger?.referredByDriverId).toBe(referrerDriver.id);
  });

  it("rejects register when referredByDriverId is used in auth/register", async () => {
    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Conflict Referral",
        email: "conflict-referral@test.com",
        password: "123456",
        role: "passenger",
        phone: "11999990017",
        referredByDriverId: "internal-id",
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Use apenas referralCode para cadastro com indicação",
    });
  });

  it("rejects register with an invalid referralCode", async () => {
    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Invalid Referral",
        email: "invalid-referral@test.com",
        password: "123456",
        role: "passenger",
        phone: "11999990018",
        referralCode: "missing-code",
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Código de referral inválido ou motorista inativo",
    });
  });

  it("registers a driver via referralCode and creates the referral chain", async () => {
    const referrerUser = await prisma.user.create({
      data: {
        name: "Referrer Driver Flow",
        email: "ref-driver@test.com",
        phone: "11999990014",
        role: "DRIVER",
      },
    });

    const referrerDriver = await prisma.driver.create({
      data: {
        userId: referrerUser.id,
        isActive: true,
        experienceLevel: "ELITE",
        referralCode: "driver-flow-code",
      },
    });

    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Driver Referral",
        email: "driver-referral@test.com",
        password: "123456",
        role: "driver",
        phone: "11999990015",
        referralCode: "driver-flow-code",
      });

    expect(response.status).toBe(201);
    expect(response.body.driverId).toBeDefined();
    expect(response.body.referralCode).toBeDefined();

    const referralEdge = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: referrerDriver.id,
        referredDriverId: response.body.driverId,
      },
    });

    expect(referralEdge).not.toBeNull();
    expect(referralEdge?.level).toBe(1);
  });

  it("blocks legacy POST /drivers for referral onboarding", async () => {
    const response = await request(app)
      .post("/drivers")
      .send({
        name: "Legacy Driver",
        email: "legacy-driver@test.com",
        phone: "11999990021",
        referralCode: "legacy-referral",
      });

    expect(response.status).toBe(410);
    expect(response.body).toEqual({
      error: "Cadastro com referral deve usar POST /auth/register",
    });
  });
});
