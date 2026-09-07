import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../src/app";
import { prisma } from "./setup";

const PASSWORD = "123456";
let sequence = 0;

function tag() {
  sequence += 1;
  return `${Date.now()}-${sequence}`;
}

async function createDriver(label: string) {
  const suffix = `${label}-${tag()}`;
  const user = await prisma.user.create({
    data: {
      name: `Book ${label}`,
      email: `${suffix}@test.com`,
      phone: `219${String(sequence).padStart(8, "0")}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash(PASSWORD, 10),
    },
  });
  const driver = await prisma.driver.create({
    data: {
      userId: user.id,
      experienceLevel: "INTERMEDIARIO",
      isActive: true,
      regions: ["ZN"],
    },
  });
  return { user, driver };
}

async function createPassenger(label: string) {
  const suffix = `${label}-${tag()}`;
  const user = await prisma.user.create({
    data: {
      name: `Book Passenger ${label}`,
      email: `${suffix}@test.com`,
      phone: `118${String(sequence).padStart(7, "0")}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash(PASSWORD, 10),
    },
  });
  const passenger = await prisma.passenger.create({ data: { userId: user.id } });
  return { user, passenger };
}

async function login(email: string) {
  const response = await request(app).post("/auth/login").send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  return response.body.accessToken as string;
}

async function offerFixture(
  driverId: string,
  passengerId: string,
  input: {
    status: "PENDING" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "PAID";
    createdAt: Date;
    expiresAt: Date;
    respondedAt?: Date | null;
    rideStatus?: "PENDING" | "MATCHING" | "WAITING_GENERAL" | "ACCEPTED" | "CANCELLED" | "COMPLETED";
    selectedDriverId?: string | null;
    currentCandidateDriverId?: string | null;
  },
) {
  const ride = await prisma.rideRequest.create({
    data: {
      passengerId,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(Date.now() + 60_000),
      status: input.rideStatus ?? "PENDING",
      selectedDriverId: input.selectedDriverId ?? null,
      currentCandidateDriverId: input.currentCandidateDriverId ?? null,
    },
  });
  const offer = await prisma.rideOffer.create({
    data: {
      rideRequestId: ride.id,
      driverId,
      status: input.status,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      respondedAt: input.respondedAt ?? null,
      driverReceivableAmountCents: 9263,
    },
  });
  return { ride, offer };
}

describe("GET /drivers/me/offers/history", () => {
  it("requires a driver Bearer session and ignores x-driver-id", async () => {
    const owner = await createDriver("owner");
    const passenger = await createPassenger("auth");
    await offerFixture(owner.driver.id, passenger.passenger.id, {
      status: "PENDING",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect((await request(app).get("/drivers/me/offers/history")).status).toBe(401);
    expect(
      (await request(app).get("/drivers/me/offers/history").set("x-driver-id", owner.driver.id)).status,
    ).toBe(401);

    const passengerToken = await login(passenger.user.email);
    expect(
      (await request(app).get("/drivers/me/offers/history").set("Authorization", `Bearer ${passengerToken}`)).status,
    ).toBe(401);
  });

  it("scopes the book to the authenticated driver and never returns passenger PII", async () => {
    const owner = await createDriver("owner");
    const other = await createDriver("other");
    const passenger = await createPassenger("privacy");
    const first = await offerFixture(owner.driver.id, passenger.passenger.id, {
      status: "REJECTED",
      respondedAt: new Date(),
      createdAt: new Date(Date.now() - 2_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await offerFixture(owner.driver.id, passenger.passenger.id, {
      status: "PENDING",
      createdAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const foreign = await offerFixture(other.driver.id, passenger.passenger.id, {
      status: "ACCEPTED",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rideStatus: "ACCEPTED",
      selectedDriverId: other.driver.id,
    });

    const token = await login(owner.user.email);
    const response = await request(app)
      .get("/drivers/me/offers/history")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.items.map((item: { offerId: string }) => item.offerId)).toEqual(
      expect.arrayContaining([first.offer.id]),
    );
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items.some((item: { offerId: string }) => item.offerId === foreign.offer.id)).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain(passenger.user.phone);
    expect(JSON.stringify(response.body)).not.toContain(passenger.passenger.id);
  });

  it("derives lifecycle statuses with explicit precedence", async () => {
    const owner = await createDriver("lifecycle-owner");
    const winner = await createDriver("lifecycle-winner");
    const passenger = await createPassenger("lifecycle");
    const now = Date.now();

    const active = await offerFixture(owner.driver.id, passenger.passenger.id, {
      status: "PENDING",
      createdAt: new Date(now - 7_000),
      expiresAt: new Date(now + 60_000),
      rideStatus: "WAITING_GENERAL",
      currentCandidateDriverId: owner.driver.id,
    });
    const accepted = await offerFixture(owner.driver.id, passenger.passenger.id, {
      status: "ACCEPTED",
      createdAt: new Date(now - 6_000),
      expiresAt: new Date(now - 5_000),
      rideStatus: "ACCEPTED",
      selectedDriverId: owner.driver.id,
    });
    const paid = await offerFixture(owner.driver.id, passenger.passenger.id, {
      status: "PAID",
      createdAt: new Date(now - 5_000),
      expiresAt: new Date(now - 4_000),
      rideStatus: "COMPLETED",
      selectedDriverId: owner.driver.id,
    });
    const rejected = await offerFixture(owner.driver.id, passenger.passenger.id, {
      status: "REJECTED",
      createdAt: new Date(now - 4_000),
      expiresAt: new Date(now + 60_000),
      respondedAt: new Date(now - 3_000),
    });
    const expired = await offerFixture(owner.driver.id, passenger.passenger.id, {
      status: "EXPIRED",
      createdAt: new Date(now - 3_000),
      expiresAt: new Date(now - 2_000),
    });
    const pendingExpired = await offerFixture(owner.driver.id, passenger.passenger.id, {
      status: "PENDING",
      createdAt: new Date(now - 2_000),
      expiresAt: new Date(now - 1_000),
    });
    const lost = await offerFixture(owner.driver.id, passenger.passenger.id, {
      status: "REJECTED",
      createdAt: new Date(now - 1_000),
      expiresAt: new Date(now + 60_000),
      selectedDriverId: winner.driver.id,
      rideStatus: "ACCEPTED",
    });
    const unavailable = await offerFixture(owner.driver.id, passenger.passenger.id, {
      status: "PENDING",
      createdAt: new Date(now),
      expiresAt: new Date(now + 60_000),
      rideStatus: "CANCELLED",
    });

    const token = await login(owner.user.email);
    const response = await request(app)
      .get("/drivers/me/offers/history?limit=50")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    const byId = new Map(response.body.items.map((item: { offerId: string; bookStatus: string }) => [item.offerId, item.bookStatus]));
    expect(byId.get(active.offer.id)).toBe("ACTIVE");
    expect(byId.get(accepted.offer.id)).toBe("ACCEPTED");
    expect(byId.get(paid.offer.id)).toBe("ACCEPTED");
    expect(byId.get(rejected.offer.id)).toBe("REJECTED");
    expect(byId.get(expired.offer.id)).toBe("EXPIRED");
    expect(byId.get(pendingExpired.offer.id)).toBe("EXPIRED");
    expect(byId.get(lost.offer.id)).toBe("LOST");
    expect(byId.get(unavailable.offer.id)).toBe("UNAVAILABLE");
    expect(response.body.items.find((item: { offerId: string }) => item.offerId === lost.offer.id).outcomeReason).toBe("ANOTHER_DRIVER_ACCEPTED");
  });

  it("uses stable keyset pagination without duplicates or skips", async () => {
    const owner = await createDriver("pagination");
    const passenger = await createPassenger("pagination");
    const createdAt = new Date(Date.now() - 10_000);
    const offers = [];
    for (let i = 0; i < 3; i += 1) {
      offers.push(await offerFixture(owner.driver.id, passenger.passenger.id, {
        status: "REJECTED",
        respondedAt: new Date(),
        createdAt,
        expiresAt: new Date(Date.now() + 60_000),
      }));
    }
    const token = await login(owner.user.email);
    const first = await request(app)
      .get("/drivers/me/offers/history?limit=2")
      .set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app)
      .get(`/drivers/me/offers/history?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.items, ...second.body.items].map((item: { offerId: string }) => item.offerId);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(expect.arrayContaining(offers.map((item) => item.offer.id)));
  });
});
