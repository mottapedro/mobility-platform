import bcrypt from "bcrypt";
import request from "supertest";
import { AuthSessionService } from "../../src/domain/auth/AuthSessionService";
import { AuthTokenService } from "../../src/domain/auth/AuthTokenService";
import { DomainEventType, RideStatus } from "../../src/shared/enums";
import { app } from "../../src/app";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { createPaymentIntent } from "../../src/domain/payment/PaymentIntentService";
import { InMemoryPixProvider } from "../../src/domain/payment/providers/InMemoryPixProvider";
import { cleanTestData, prisma } from "../setup";
import { useRevenuePolicyFixture } from "../fixtures/revenue-policy.fixture";

useRevenuePolicyFixture(prisma, cleanTestData);

async function makePassenger(email: string) {
  const user = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("password", 4),
    },
  });
  const passenger = await prisma.passenger.create({
    data: {
      userId: user.id,
      referralCode: `manual-${user.id.slice(0, 8)}`,
      publicSlug: `manual-${user.id.slice(0, 8)}`,
    },
  });
  return { user, passenger };
}

async function makeDriver(email: string) {
  const user = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("password", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: user.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

async function bearerFor(userId: string) {
  const session = await new AuthSessionService({ refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1_000 }).createSession(userId);
  return new AuthTokenService().issueAccessToken({ userId, sessionId: session.session.id });
}

async function seedRide(emailPrefix: string) {
  const driver = await makeDriver(`${emailPrefix}.driver@test.com`);
  const passenger = await makePassenger(`${emailPrefix}.passenger@test.com`);
  await prisma.passenger.update({ where: { id: passenger.passenger.id }, data: { rootDriverId: driver.id } });
  const ride = await prisma.rideRequest.create({
    data: {
      passengerId: passenger.passenger.id,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(),
      status: RideStatus.COMPLETED,
      selectedDriverId: driver.id,
      priceEstimated: 100,
    },
  });
  const intent = await createPaymentIntent({
    rideRequestId: ride.id,
    amountCents: 10_000,
    provider: new InMemoryPixProvider(),
    bus: createEventBus(),
  });
  return { driver, passenger, ride, intent, token: await bearerFor(passenger.user.id) };
}

describe("manual static PIX confirmation", () => {
  it("requires passenger Bearer auth and ownership", async () => {
    const seeded = await seedRide("manual.auth");
    const other = await makePassenger("manual.other@test.com");
    const otherToken = await bearerFor(other.user.id);

    expect((await request(app).post(`/rides/${seeded.ride.id}/payment-intent/manual-confirm`)).status).toBe(401);
    const forbidden = await request(app)
      .post(`/rides/${seeded.ride.id}/payment-intent/manual-confirm`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(forbidden.status).toBe(403);
  });

  it("confirms PENDING once, replays idempotently, and records MANUAL audit mode", async () => {
    const seeded = await seedRide("manual.confirm");
    const endpoint = `/rides/${seeded.ride.id}/payment-intent/manual-confirm`;
    const first = await request(app).post(endpoint).set("Authorization", `Bearer ${seeded.token}`);
    const second = await request(app).post(endpoint).set("Authorization", `Bearer ${seeded.token}`);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      success: true,
      rideId: seeded.ride.id,
      status: "CONFIRMED",
      confirmationMode: "MANUAL",
      settled: true,
    });
    expect(second.status).toBe(200);
    expect(second.body.settled).toBe(false);
    expect(await prisma.paymentIntent.count({ where: { id: seeded.intent.id, status: "CONFIRMED" } })).toBe(1);
    expect(await prisma.settlement.count({ where: { paymentIntentId: seeded.intent.id } })).toBe(1);
    expect(await prisma.revenueSplit.count({ where: { settlement: { paymentIntentId: seeded.intent.id } } })).toBe(3);
    expect((await prisma.rideRequest.findUniqueOrThrow({ where: { id: seeded.ride.id } })).status).toBe(RideStatus.COMPLETED);

    const paymentEvents = await prisma.domainEvent.findMany({
      where: { type: DomainEventType.PAYMENT_CONFIRMED, aggregateId: seeded.intent.id },
    });
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].payload).toEqual(expect.objectContaining({ confirmationMode: "MANUAL" }));
  });

  it("does not resurrect an incompatible PaymentIntent status", async () => {
    const seeded = await seedRide("manual.failed");
    await prisma.paymentIntent.update({ where: { id: seeded.intent.id }, data: { status: "FAILED", failedAt: new Date() } });

    const response = await request(app)
      .post(`/rides/${seeded.ride.id}/payment-intent/manual-confirm`)
      .set("Authorization", `Bearer ${seeded.token}`);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("PAYMENT_NOT_CONFIRMABLE");
    expect(await prisma.settlement.count({ where: { paymentIntentId: seeded.intent.id } })).toBe(0);
  });
});
