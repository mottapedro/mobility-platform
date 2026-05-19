import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../src/app";
import { prisma } from "./setup";

async function createDriverWithRegion(params: {
  name: string;
  email: string;
  region: string;
}) {
  const user = await prisma.user.create({
    data: {
      name: params.name,
      email: params.email,
      phone: "21999990000",
      role: "DRIVER",
      passwordHash: await bcrypt.hash("123456", 10),
    },
  });

  const driver = await prisma.driver.create({
    data: {
      userId: user.id,
      isActive: true,
      experienceLevel: "INTERMEDIARIO",
      regions: [params.region],
    },
  });

  return driver;
}

describe("POST /auth/register with referralCode", () => {
  it("creates a referred driver with direct parent, network level, slug, and referral code", async () => {
    const referrer = await createDriverWithRegion({
      name: "Carlos Silva",
      email: "carlos.driver@ref.com",
      region: "ZN",
    });

    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Marcos Lima",
        email: "marcos.driver@ref.com",
        password: "123456",
        role: "driver",
        phone: "21988887777",
        referralCode: "carlos-silva-zn",
        regions: ["ZS"],
      });

    expect(response.status).toBe(201);

    const driver = await prisma.driver.findUniqueOrThrow({
      where: { id: response.body.driverId },
    });

    expect(driver.referredByDriverId).toBe(referrer.id);
    expect(driver.networkLevel).toBe(1);
    expect(driver.publicSlug).toBe("marcos-lima");
    expect(driver.referralCode).toBe("marcos-lima-zs");
  });

  it("creates a passenger linked to the resolved driver", async () => {
    const driver = await createDriverWithRegion({
      name: "Carlos Silva",
      email: "carlos.silva@ref.com",
      region: "ZS",
    });

    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Ana Passageira",
        email: "ana.passageira@ref.com",
        password: "123456",
        role: "passenger",
        phone: "21988887777",
        referralCode: "carlos-zs",
      });

    expect(response.status).toBe(201);
    expect(response.body.passengerId).toBeDefined();
    expect(response.body.referredByDriverId).toBe(driver.id);

    const passenger = await prisma.passenger.findUnique({
      where: { id: response.body.passengerId },
    });

    expect(passenger?.referredByDriverId).toBe(driver.id);
  });

  it("links referredByDriverId when a raw driver UUID is supplied as referredByDriverId", async () => {
    const driver = await createDriverWithRegion({
      name: "Paula Motorista",
      email: "paula.motorista@ref.com",
      region: "ZN",
    });

    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Roberto Passageiro",
        email: "roberto.passageiro@ref.com",
        password: "123456",
        role: "passenger",
        phone: "21966665555",
        referredByDriverId: driver.id,
      });

    expect(response.status).toBe(201);
    expect(response.body.passengerId).toBeDefined();
    expect(response.body.referredByDriverId).toBe(driver.id);

    const passenger = await prisma.passenger.findUnique({
      where: { id: response.body.passengerId },
    });

    expect(passenger?.referredByDriverId).toBe(driver.id);
  });

  it("returns 400 when the referral code is invalid", async () => {
    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Bruno Sem Referral",
        email: "bruno.sem.ref@ref.com",
        password: "123456",
        role: "passenger",
        phone: "21977776666",
        referralCode: "codigo-invalido",
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Referral code inválido");

    const passenger = await prisma.user.findUnique({
      where: { email: "bruno.sem.ref@ref.com" },
    });

    expect(passenger).toBeNull();
  });
});

// ─── passenger referral code on register ─────────────────────────────────────
describe("POST /auth/register — passenger referralCode", () => {
  it("links referredByPassengerId when a valid passenger referralCode is supplied", async () => {
    // Create referrer passenger with a known referral code
    await prisma.user.create({
      data: {
        name: "Referrer",
        email: "referrer-reg@ptest.com",
        phone: "11900000099",
        role: "PASSENGER",
        passenger: { create: { referralCode: "referrer-reg-xxxx" } },
      },
      include: { passenger: true },
    });

    const referrer = await prisma.passenger.findFirst({
      where: { user: { email: "referrer-reg@ptest.com" } },
    });
    const referrerId = referrer!.id;

    const res = await request(app).post("/auth/register").send({
      name: "New Passenger",
      email: "newp-reg@ptest.com",
      phone: "11900000088",
      role: "passenger",
      password: "senha123",
      referralCode: "referrer-reg-xxxx",
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("passengerId");

    const created = await prisma.passenger.findUnique({
      where: { id: res.body.passengerId },
    });
    expect(created).not.toBeNull();
    expect(created!.referredByPassengerId).toBe(referrerId);
    expect(created!.networkLevel).toBe(1);
  });

  it("returns 400 when referralCode matches neither a driver nor a passenger", async () => {
    const res = await request(app).post("/auth/register").send({
      name: "Ghost User",
      email: "ghost-reg@ptest.com",
      phone: "11900000077",
      role: "passenger",
      password: "senha123",
      referralCode: "totally-unknown-zzzz",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inválido/i);
  });
});

// ─── auto-generated passenger identity ───────────────────────────────────────
describe("POST /auth/register — auto-generates passenger identity", () => {
  it("returns non-null referralCode and publicSlug for every new passenger", async () => {
    const res = await request(app).post("/auth/register").send({
      name: "Maria Fernanda",
      email: "mariaf-identity@ptest.com",
      phone: "11900000001",
      role: "passenger",
      password: "senha123",
    });

    expect(res.status).toBe(201);
    expect(res.body.referralCode).toMatch(/^[a-z0-9-]+-[a-z0-9]{4}$/);
    expect(res.body.publicSlug).toMatch(/^maria-fernanda/);

    // Verify persisted to DB
    const p = await prisma.passenger.findUnique({ where: { id: res.body.passengerId } });
    expect(p?.referralCode).toBe(res.body.referralCode);
    expect(p?.publicSlug).toBe(res.body.publicSlug);
  });
});
