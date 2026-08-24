// P0 — contrato HTTP: passwordHash/tokens/segredos jamais cruzam a fronteira.
//
// Incidente: GET /rides/:id e POST /rides serializavam `include: { user: true }`
// → bcrypt de passenger.user e selectedDriver.user no payload HTTP. Este spec
// garante ausência recursiva de campos sensíveis em todo o corpo de resposta
// dos endpoints de corrida, mesmo com passwordHash persistido no banco.

/// <reference types="jest" />
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../src/app";
import { prisma, cleanTestData } from "./setup";
import { DriverOperationalBaseService } from "../src/domain/driver/DriverOperationalBaseService";
import { AuthSessionService } from "../src/domain/auth/AuthSessionService";
import { AuthTokenService } from "../src/domain/auth/AuthTokenService";

jest.setTimeout(20000);

const baseService = new DriverOperationalBaseService();
const SECRET_KEYS = ["passwordHash", "password", "tokens", "secret", "apiKey"];

let seq = 0;
function tag() {
  seq += 1;
  return `${Date.now()}.${seq}`;
}

function assertNoSecretKeys(body: unknown) {
  const serialized = JSON.stringify(body ?? {});
  for (const key of SECRET_KEYS) {
    expect(serialized).not.toContain(`"${key}"`);
  }
}

async function createDriverUser(email: string): Promise<string> {
  const passwordHash = await bcrypt.hash("123456", 10);
  const user = await prisma.user.create({
    data: {
      name: "P0 Driver",
      email,
      phone: "1193333000",
      role: "DRIVER",
      passwordHash,
      driver: {
        create: { experienceLevel: "PROFISSIONAL", isActive: true },
      },
    },
    include: { driver: true },
  });
  return user.driver!.id;
}

async function createPassengerUser(
  email: string,
  referredByDriverId?: string,
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "P0 Passenger",
      email,
      phone: "1194444000",
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("123456", 10),
    },
  });
  const passenger = await prisma.passenger.create({
    data: {
      userId: user.id,
      referralCode: `p0-psg-${tag()}`,
      publicSlug: `p0-psg-${tag()}`,
      ...(referredByDriverId ? { referredByDriverId } : {}),
    },
  });
  return passenger.id;
}

function rideBody(passengerId: string) {
  return {
    passengerId,
    origin: "Zona Norte",
    destination: "Centro",
    originLat: -23.55,
    originLng: -46.63,
    destinationLat: -23.9,
    destinationLng: -46.65,
  };
}

async function bearerForPassenger(passengerId: string) {
  const passenger = await prisma.passenger.findUniqueOrThrow({
    where: { id: passengerId },
    select: { userId: true },
  });
  const session = await new AuthSessionService().createSession(passenger.userId);
  return new AuthTokenService().issueAccessToken({
    userId: passenger.userId,
    sessionId: session.session.id,
  });
}

describe("P0 — sem passwordHash/tokens em respostas HTTP de corrida", () => {
  it("POST /rides (sem M1) e GET /rides/:id não serializam segredos", async () => {
    const passenger = await createPassengerUser(`p0.nom1.${tag()}@test.com`);

    const create = await request(app)
      .post("/rides")
      .send(rideBody(passenger));
    expect(create.status).toBe(201);
    assertNoSecretKeys(create.body);
    expect(create.body.ride.passenger.user?.passwordHash).toBeUndefined();

    const token = await bearerForPassenger(passenger);
    const get = await request(app)
      .get(`/rides/${create.body.ride.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    assertNoSecretKeys(get.body);
    expect(get.body.passenger.user?.passwordHash).toBeUndefined();
  });

  it("POST /rides (M1 com quote) e confirm-quote não serializam segredos", async () => {
    const m1 = await createDriverUser(`p0.m1.${tag()}@test.com`);
    await baseService.save(m1, {
      address: "Base Centro",
      lat: -23.55,
      lng: -46.63,
    });
    const passenger = await createPassengerUser(`p0.psg.${tag()}@test.com`, m1);

    const create = await request(app)
      .post("/rides")
      .send({
        ...rideBody(passenger),
        scheduledAt: new Date(Date.now() + 90_000_000).toISOString(),
      });
    expect(create.status).toBe(201);
    assertNoSecretKeys(create.body);
    expect(create.body.rideQuote?.status).toBe("QUOTED");

    const confirm = await request(app)
      .post(`/rides/${create.body.ride.id}/confirm-quote`)
      .send();
    expect(confirm.status).toBe(200);
    assertNoSecretKeys(confirm.body);
    // selectedDriver.user e passenger.user já presentes no payload → cobertos
    // pela varredura recursiva acima.
    expect(JSON.stringify(confirm.body)).not.toContain("passwordHash");
  });

  it("o passwordHash continua persistido no banco (select apenas escondou a serialização)", async () => {
    const email = `p0.persist.${tag()}@test.com`;
    const user = await prisma.user.create({
      data: {
        name: "P0 Persist",
        email,
        phone: "1195555000",
        role: "DRIVER",
        passwordHash: await bcrypt.hash("123456", 10),
      },
    });

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
  });
});
