import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";

jest.setTimeout(10000);

// ─── Shared helpers ────────────────────────────────────────────────────────
const BASE_DRIVER = {
  name: "Motorista Teste",
  email: "motorista@auth.com",
  password: "senha123",
  role: "driver",
  phone: "",
  experienceLevel: "PROFISSIONAL",
  vehicle: {
    model: "Corolla",
    brand: "Toyota",
    plate: "TST-0001",
    category: "EXECUTIVO",
  },
  region: ["ZN", "ZS"],
};

// ─── POST /auth/register — Motorista ──────────────────────────────────────
describe("POST /auth/register — motorista", () => {
  it("deve criar user, driver, veículo e regiões corretamente", async () => {
    const res = await request(app).post("/auth/register").send(BASE_DRIVER);

    expect(res.status).toBe(201);
    expect(res.body.driverId).toBeDefined();
    expect(res.body.user.role).toBe("driver");
    expect(res.body.user.email).toBe(BASE_DRIVER.email);

    const vehicle = await prisma.vehicle.findFirst({
      where: { driverId: res.body.driverId },
    });
    expect(vehicle).not.toBeNull();
    expect(vehicle?.plate).toBe("TST-0001");
    expect(vehicle?.category).toBe("EXECUTIVO");
    expect(vehicle?.model).toBe("Corolla");
    expect(vehicle?.brand).toBe("Toyota");

    const regions = await prisma.driverRegion.findMany({
      where: { driverId: res.body.driverId },
    });
    expect(regions).toHaveLength(2);
    const regionValues = regions.map((r) => r.region);
    expect(regionValues).toContain("ZN");
    expect(regionValues).toContain("ZS");
  });

  it("deve persistir o experienceLevel informado", async () => {
    const res = await request(app).post("/auth/register").send({
      ...BASE_DRIVER,
      email: "elite@auth.com",
      vehicle: { ...BASE_DRIVER.vehicle, plate: "TST-0002" },
      experienceLevel: "ELITE",
    });

    expect(res.status).toBe(201);

    const driver = await prisma.driver.findUnique({ where: { id: res.body.driverId } });
    expect(driver?.experienceLevel).toBe("ELITE");
  });

  it("deve rejeitar quando vehicle está ausente", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { vehicle: _v, ...payload } = BASE_DRIVER as Record<string, unknown>;
    const res = await request(app).post("/auth/register").send({
      ...payload,
      email: "semveiculo@auth.com",
    });

    expect(res.status).toBe(400);
  });

  it("deve rejeitar quando region é array vazio", async () => {
    const res = await request(app).post("/auth/register").send({
      ...BASE_DRIVER,
      email: "semregiao@auth.com",
      vehicle: { ...BASE_DRIVER.vehicle, plate: "TST-0003" },
      region: [],
    });

    expect(res.status).toBe(400);
  });

  it("deve rejeitar experienceLevel inválido", async () => {
    const res = await request(app).post("/auth/register").send({
      ...BASE_DRIVER,
      email: "expinvalido@auth.com",
      vehicle: { ...BASE_DRIVER.vehicle, plate: "TST-0004" },
      experienceLevel: "SUPERMAN",
    });

    expect(res.status).toBe(400);
  });

  it("deve rejeitar categoria de veículo inválida", async () => {
    const res = await request(app).post("/auth/register").send({
      ...BASE_DRIVER,
      email: "catinvalida@auth.com",
      vehicle: { ...BASE_DRIVER.vehicle, plate: "TST-0005", category: "LUXO" },
    });

    expect(res.status).toBe(400);
  });

  it("deve rejeitar email duplicado", async () => {
    await request(app).post("/auth/register").send(BASE_DRIVER);

    const res = await request(app).post("/auth/register").send({
      ...BASE_DRIVER,
      vehicle: { ...BASE_DRIVER.vehicle, plate: "TST-0099" },
    });

    expect(res.status).toBe(400);
  });
});

// ─── POST /auth/register — Passageiro ─────────────────────────────────────
describe("POST /auth/register — passageiro", () => {
  it("deve registrar passageiro sem indicação e retornar passengerId", async () => {
    const res = await request(app).post("/auth/register").send({
      name: "Passageiro Teste",
      email: "passageiro@auth.com",
      password: "senha123",
      role: "passenger",
      phone: "11999990001",
    });

    expect(res.status).toBe(201);
    expect(res.body.passengerId).toBeDefined();
    expect(res.body.referredByDriverId).toBeNull();
    expect(res.body.user.role).toBe("passenger");
  });

  it("deve registrar passageiro com motorista indicado e persistir relação", async () => {
    const driverRes = await request(app).post("/auth/register").send({
      ...BASE_DRIVER,
      name: "Driver Indicador",
      email: "indicador@auth.com",
      vehicle: { ...BASE_DRIVER.vehicle, plate: "IND-0001" },
    });
    expect(driverRes.status).toBe(201);

    const res = await request(app).post("/auth/register").send({
      name: "Passageiro Indicado",
      email: "indicado@auth.com",
      password: "senha123",
      role: "passenger",
      phone: "11999990002",
      referredByDriverId: driverRes.body.driverId,
    });

    expect(res.status).toBe(201);
    expect(res.body.referredByDriverId).toBe(driverRes.body.driverId);

    const passenger = await prisma.passenger.findUnique({
      where: { id: res.body.passengerId },
    });
    expect(passenger?.referredByDriverId).toBe(driverRes.body.driverId);
  });

  it("deve rejeitar passageiro com motorista indicado inexistente", async () => {
    const res = await request(app).post("/auth/register").send({
      name: "Pax Invalido",
      email: "paxinvalido@auth.com",
      password: "senha123",
      role: "passenger",
      phone: "11999990003",
      referredByDriverId: "00000000-0000-0000-0000-000000000000",
    });

    expect(res.status).toBe(400);
  });
});

// ─── POST /auth/login ──────────────────────────────────────────────────────
describe("POST /auth/login", () => {
  it("deve autenticar motorista e retornar driverId", async () => {
    await request(app).post("/auth/register").send(BASE_DRIVER);

    const res = await request(app).post("/auth/login").send({
      email: BASE_DRIVER.email,
      password: BASE_DRIVER.password,
    });

    expect(res.status).toBe(200);
    expect(res.body.driverId).toBeDefined();
    expect(res.body.user.role).toBe("driver");
  });

  it("deve autenticar passageiro e retornar passengerId", async () => {
    await request(app).post("/auth/register").send({
      name: "Pax Login",
      email: "paxlogin@auth.com",
      password: "senha123",
      role: "passenger",
      phone: "11999990010",
    });

    const res = await request(app).post("/auth/login").send({
      email: "paxlogin@auth.com",
      password: "senha123",
    });

    expect(res.status).toBe(200);
    expect(res.body.passengerId).toBeDefined();
    expect(res.body.user.role).toBe("passenger");
  });

  it("deve rejeitar senha incorreta com 401", async () => {
    await request(app).post("/auth/register").send(BASE_DRIVER);

    const res = await request(app).post("/auth/login").send({
      email: BASE_DRIVER.email,
      password: "senhaerrada",
    });

    expect(res.status).toBe(401);
  });

  it("deve rejeitar email inexistente com 401", async () => {
    const res = await request(app).post("/auth/login").send({
      email: "naoexiste@auth.com",
      password: "qualquer",
    });

    expect(res.status).toBe(401);
  });
});
