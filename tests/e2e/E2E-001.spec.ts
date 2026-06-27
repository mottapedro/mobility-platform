import { test, expect, APIRequestContext, request as playwrightRequest } from "@playwright/test";

/**
 * E2E-001: Core Operation (Dispatch Flow) — Self-Contained Semantic Contract Edition.
 *
 * This spec validates the Runtime Engine through REST data contracts only.
 * It does not depend on UI selectors, spinners, or DOM state.  The frontend
 * consumer running on port 3001 is irrelevant here; what matters is the JSON
 * language the Mobility Platform returns.
 *
 * The test is self-contained: it registers a fresh driver and passenger before
 * each run, so it works against an empty database (typical for homologation
 * environments) and avoids brittle hard-coded seed actors.
 *
 * Required: server running on http://localhost:3000 with NODE_ENV !== "production".
 * Run with: npm run test:e2e
 */

const BASE = "http://localhost:3000";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function registerPassenger(
  ctx: APIRequestContext,
  email: string,
  password: string,
  name: string,
  phone: string,
  driverReferralCode?: string
): Promise<{ passengerId: string; rootDriverId?: string }> {
  const res = await ctx.post(`${BASE}/auth/register`, {
    data: { name, email, password, role: "passenger", phone, referralCode: driverReferralCode },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Passenger register failed: ${res.status()} — ${body}`);
  }

  const body = await res.json();
  return { passengerId: body.passengerId, rootDriverId: body.rootDriverId ?? body.referredByDriverId ?? undefined };
}

async function registerDriver(
  ctx: APIRequestContext,
  email: string,
  password: string,
  name: string,
  phone: string
): Promise<{ driverId: string; referralCode: string }> {
  const res = await ctx.post(`${BASE}/auth/register`, {
    data: { name, email, password, role: "driver", phone },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Driver register failed: ${res.status()} — ${body}`);
  }

  const body = await res.json();
  return { driverId: body.driverId, referralCode: body.referralCode };
}

async function login(
  ctx: APIRequestContext,
  email: string,
  password: string
): Promise<{ passengerId?: string; driverId?: string }> {
  const res = await ctx.post(`${BASE}/auth/login`, {
    data: { email, password },
  });

  console.log(`[E2E-001] Login status for ${email}:`, res.status(), await res.text());

  if (!res.ok()) {
    throw new Error(`Login failed for ${email}: ${res.status()}`);
  }

  const body = await res.json();
  return { passengerId: body.passengerId, driverId: body.driverId };
}

async function createRide(
  ctx: APIRequestContext,
  passengerId: string,
  origin = "Rua A, 123",
  destination = "Rua B, 456"
): Promise<{ rideId: string; status: string; currentDispatchStage?: string }> {
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const res = await ctx.post(`${BASE}/rides`, {
    data: { passengerId, origin, destination, scheduledAt },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Create ride failed: ${res.status()} — ${body}`);
  }

  const body = await res.json();
  const ride = body.ride ?? body;
  return { rideId: ride.id, status: ride.status, currentDispatchStage: ride.currentDispatchStage };
}

async function getDriverOffers(
  ctx: APIRequestContext,
  driverId: string
): Promise<Array<{ id: string; rideRequestId: string; status: string; driverId?: string; priceBrl?: number }>> {
  const res = await ctx.get(`${BASE}/drivers/${driverId}/offers`, {
    headers: { "x-driver-id": driverId },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Get driver offers failed: ${res.status()} — ${body}`);
  }

  return res.json();
}

async function waitForOffer(
  ctx: APIRequestContext,
  driverId: string,
  rideId: string,
  maxWaitMs = 10_000,
  intervalMs = 400
): Promise<{ id: string; rideRequestId: string; status: string; priceBrl: number }> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const offers = await getDriverOffers(ctx, driverId);
    const match = offers.find((o) => o.rideRequestId === rideId && o.status === "PENDING");

    if (match) {
      console.log(`[E2E-001] Offer found for driver=${driverId}: ${match.id}`);
      return { ...match, priceBrl: match.priceBrl ?? 0 };
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Timeout waiting for offer: rideId=${rideId} driverId=${driverId}`);
}

async function respondToOffer(
  ctx: APIRequestContext,
  offerId: string,
  accept: boolean
): Promise<{ accepted: boolean }> {
  const res = await ctx.patch(`${BASE}/offers/${offerId}/respond`, {
    data: { accept },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Respond to offer failed: ${res.status()} — ${body}`);
  }

  return res.json();
}

async function getRide(
  ctx: APIRequestContext,
  rideId: string
): Promise<{ status: string; selectedDriverId: string | null; currentDispatchStage?: string }> {
  const res = await ctx.get(`${BASE}/rides/${rideId}`);

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Get ride failed: ${res.status()} — ${body}`);
  }

  const body = await res.json();
  const ride = body.ride ?? body;
  return {
    status: ride.status,
    selectedDriverId: ride.selectedDriverId ?? null,
    currentDispatchStage: ride.currentDispatchStage,
  };
}

// ─── Test setup ─────────────────────────────────────────────────────────────

let passengerCtx: APIRequestContext;
let driverCtx: APIRequestContext;

let passengerId: string;
let driverId: string;
let passengerEmail: string;
let driverEmail: string;
const PASSWORD = "e2e123456";

test.beforeAll(async () => {
  passengerCtx = await playwrightRequest.newContext({ baseURL: BASE });
  driverCtx = await playwrightRequest.newContext({ baseURL: BASE });
});

test.beforeEach(async () => {
  // Self-contained actors — no dependency on golden seed or external DB state.
  driverEmail = `e2e.driver.${Date.now()}@test.com`;
  passengerEmail = `e2e.passenger.${Date.now()}@test.com`;

  // Register driver first so we can bind the passenger to him via referral code.
  // This sets the passenger's rootDriverId, triggering OWNER_DISPATCH for the ride
  // and guaranteeing the offer is sent to this specific driver.
  const driver = await registerDriver(driverCtx, driverEmail, PASSWORD, "E2E Driver", "21900000002");
  driverId = driver.driverId;

  const passenger = await registerPassenger(
    passengerCtx,
    passengerEmail,
    PASSWORD,
    "E2E Passenger",
    "21900000001",
    driver.referralCode
  );
  passengerId = passenger.passengerId;

  console.log(`\n[E2E-001] Actors: passenger=${passengerId} (${passengerEmail}) driver=${driverId} (${driverEmail}) rootDriverId=${passenger.rootDriverId}\n`);
});

test.afterAll(async () => {
  await passengerCtx.dispose();
  await driverCtx.dispose();
});

// ─── Scenario: Passenger creates a ride, driver receives and accepts offer ───

test("Passenger creates a ride and the driver accepts the offer", async () => {
  // Step 1 — Authenticate both actors
  await test.step("1 — Authenticate passenger and driver", async () => {
    await login(passengerCtx, passengerEmail, PASSWORD);
    await login(driverCtx, driverEmail, PASSWORD);
  });

  // Step 2 — Passenger creates a ride
  const { rideId, status: initialStatus, currentDispatchStage: initialStage } = await test.step(
    "2 — Passenger creates a ride",
    async () => {
      const ride = await createRide(passengerCtx, passengerId);
      // Contract: the runtime may report the ride as REQUESTED or PENDING
      // immediately after creation, depending on whether the matching job has
      // already started.  Both are valid pre-dispatch states.
      expect(["REQUESTED", "PENDING"]).toContain(ride.status);
      expect(typeof ride.currentDispatchStage).toBe("string");
      expect(["OWNER_DISPATCH", "NETWORK_DISPATCH"]).toContain(ride.currentDispatchStage);
      return ride;
    }
  );

  console.log(`[E2E-001] Ride created: id=${rideId} status=${initialStatus} stage=${initialStage}`);

  // Step 3 — Driver receives a pending offer
  const offer = await test.step("3 — Driver receives pending offer", async () => {
    const match = await waitForOffer(driverCtx, driverId, rideId);
    expect(match.rideRequestId).toBe(rideId);
    expect(match.driverId).toBe(driverId);
    expect(typeof match.priceBrl).toBe("number");
    return match;
  });

  // Step 4 — Driver accepts the offer
  await test.step("4 — Driver accepts the offer", async () => {
    const result = await respondToOffer(driverCtx, offer.id, true);
    expect(result.accepted).toBe(true);
  });

  // Step 5 — Ride reaches ACCEPTED state
  await test.step("5 — Ride is ACCEPTED with selectedDriverId", async () => {
    const ride = await getRide(passengerCtx, rideId);
    expect(ride.status).toBe("ACCEPTED");
    expect(ride.selectedDriverId).toBe(driverId);
    if (ride.currentDispatchStage != null) {
      expect(typeof ride.currentDispatchStage).toBe("string");
    }
  });

  console.log(`[E2E-001] ✅ Dispatch flow complete. ride=${rideId} driver=${driverId}`);
});
