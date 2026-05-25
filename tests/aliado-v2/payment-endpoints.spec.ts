import bcrypt from "bcrypt";
import request from "supertest";
import { PaymentStatus, RideStatus } from "../../src/shared/enums";
import { app } from "../../src/app";
import { prisma } from "../setup";

async function makeDriver(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

async function makePassenger(email: string, rootDriverId: string | null) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.passenger.create({
    data: {
      userId: u.id,
      referralCode: `r-${u.id.slice(0, 6)}`,
      publicSlug: `s-${u.id.slice(0, 6)}`,
      rootDriverId: rootDriverId ?? undefined,
    },
  });
}

async function makeRide(passengerId: string, driverId: string) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(),
      status: RideStatus.COMPLETED,
      selectedDriverId: driverId,
    },
  });
}

describe("Payment HTTP endpoints", () => {
  it("POST /rides/:id/payment-intent returns 201 with intent + qrCode", async () => {
    const driver = await makeDriver("ep.pi.driver@test.com");
    const passenger = await makePassenger("ep.pi.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);

    const res = await request(app)
      .post(`/rides/${ride.id}/payment-intent`)
      .send({ amountCents: 3000 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe(PaymentStatus.PENDING);
    expect(res.body.amountCents).toBe(3000);
    expect(res.body.externalId).toMatch(/^pix_/);
    expect(typeof res.body.qrCode).toBe("string");
  });

  it("POST /webhooks/pix CONFIRMED settles the ride and is idempotent", async () => {
    const driver = await makeDriver("ep.wh.driver@test.com");
    const root = await makeDriver("ep.wh.root@test.com");
    const passenger = await makePassenger("ep.wh.passenger@test.com", root.id);
    const ride = await makeRide(passenger.id, driver.id);

    const intentRes = await request(app)
      .post(`/rides/${ride.id}/payment-intent`)
      .send({ amountCents: 10_000 });
    const externalId = intentRes.body.externalId as string;

    const wh1 = await request(app)
      .post(`/webhooks/pix`)
      .send({ externalId, status: "CONFIRMED" });
    expect(wh1.status).toBe(200);

    const wh2 = await request(app)
      .post(`/webhooks/pix`)
      .send({ externalId, status: "CONFIRMED" });
    expect(wh2.status).toBe(200);

    const settleRes = await request(app).get(`/rides/${ride.id}/settlement`);
    expect(settleRes.status).toBe(200);
    expect(settleRes.body.totalCents).toBe(10_000);
    expect(settleRes.body.driverCents).toBe(8_000);
    expect(settleRes.body.platformCents).toBe(1_500);
    expect(settleRes.body.rootDriverCents).toBe(500);
    expect(Array.isArray(settleRes.body.splits)).toBe(true);
    expect(settleRes.body.splits).toHaveLength(3);

    const ride2 = await prisma.rideRequest.findUnique({ where: { id: ride.id } });
    expect(ride2?.status).toBe(RideStatus.PAID);
  });

  it("GET /rides/:id/settlement returns 404 when not settled yet", async () => {
    const driver = await makeDriver("ep.404.driver@test.com");
    const passenger = await makePassenger("ep.404.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);

    const res = await request(app).get(`/rides/${ride.id}/settlement`);
    expect(res.status).toBe(404);
  });

  it("POST /webhooks/pix rejects unknown externalId with 404", async () => {
    const res = await request(app)
      .post(`/webhooks/pix`)
      .send({ externalId: "pix_unknown", status: "CONFIRMED" });
    expect(res.status).toBe(404);
  });
});
