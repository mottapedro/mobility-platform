import request from "supertest";
import bcrypt from "bcrypt";
import { Region } from "@prisma/client";
import { app } from "../src/app";
import { prisma } from "./setup";

async function createDriverWithRegion(params: {
  name: string;
  email: string;
  region: Region;
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
    },
  });

  await prisma.driverRegion.create({
    data: {
      driverId: driver.id,
      region: params.region,
    },
  });

  return driver;
}

describe("POST /auth/register with referralCode", () => {
  it("creates a passenger linked to the resolved driver", async () => {
    const driver = await createDriverWithRegion({
      name: "Carlos Silva",
      email: "carlos.silva@ref.com",
      region: Region.ZS,
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