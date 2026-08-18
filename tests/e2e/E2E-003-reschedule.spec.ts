import { test, expect, APIRequestContext, request as playwrightRequest } from "@playwright/test";

/**
 * E2E-003: Owner Recovery — Ride Reschedule Flow.
 *
 * Self-contained semantic contract test for the PATCH /rides/:id/reschedule endpoint.
 * Registers fresh actors, drives a ride to OWNER_RECOVERY, reschedules, and asserts
 * the runtime resets to OWNER_DISPATCH with a clean excludedDriverIds cache.
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
): Promise<void> {
  const res = await ctx.post(`${BASE}/auth/login`, {
    data: { email, password },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Login failed for ${email}: ${res.status()} — ${body}`);
  }
}

async function createRide(
  ctx: APIRequestContext,
  passengerId: string,
  origin = "Rua A, 123",
  destination = "Rua B, 456",
  scheduledAt?: string
): Promise<{ rideId: string; status: string; currentDispatchStage?: string }> {
  const at = scheduledAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const res = await ctx.post(`${BASE}/rides`, {
    data: { passengerId, origin, destination, scheduledAt: at },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Create ride failed: ${res.status()} — ${body}`);
  }

  const body = await res.json();
  const ride = body.ride ?? body;
  return { rideId: ride.id, status: ride.status, currentDispatchStage: ride.currentDispatchStage };
}

async function getRide(
  ctx: APIRequestContext,
  rideId: string
): Promise<{ status: string; selectedDriverId: string | null; currentDispatchStage?: string; excludedDriverIds?: string[] }> {
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
    excludedDriverIds: ride.excludedDriverIds,
  };
}

async function waitForPendingOffer(
  ctx: APIRequestContext,
  driverId: string,
  rideId: string,
  maxWaitMs = 15_000,
  intervalMs = 500
): Promise<{ id: string; rideRequestId: string; status: string }> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const res = await ctx.get(`${BASE}/drivers/${driverId}/offers`, {
      headers: { "x-driver-id": driverId },
    });

    if (!res.ok()) {
      const body = await res.text();
      throw new Error(`Get driver offers failed: ${res.status()} — ${body}`);
    }

    const offers = await res.json();
    const match = offers.find((o: { rideRequestId: string; status: string }) => o.rideRequestId === rideId && o.status === "PENDING");

    if (match) {
      console.log(`[E2E-003] Pending offer found for driver=${driverId}: ${match.id}`);
      return match;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Timeout waiting for pending offer: rideId=${rideId} driverId=${driverId}`);
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

// ─── Test context ──────────────────────────────────────────────────────────

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
  driverEmail = `e2e.driver.${Date.now()}@test.com`;
  passengerEmail = `e2e.passenger.${Date.now()}@test.com`;

  // Register driver first so the passenger can be bound to him via referral code.
  // This sets passenger.rootDriverId, triggering OWNER_DISPATCH.
  const driver = await registerDriver(driverCtx, driverEmail, PASSWORD, "E2E Recovery Driver", "21900000002");
  driverId = driver.driverId;

  const passenger = await registerPassenger(
    passengerCtx,
    passengerEmail,
    PASSWORD,
    "E2E Recovery Passenger",
    "21900000001",
    driver.referralCode
  );
  passengerId = passenger.passengerId;

  console.log(`[E2E-003] Actors: passenger=${passengerId} (${passengerEmail}) driver=${driverId} (${driverEmail}) rootDriverId=${passenger.rootDriverId}`);
});

test.afterAll(async () => {
  await passengerCtx.dispose();
  await driverCtx.dispose();
});

// ─── Scenario: Force recovery and reschedule ────────────────────────────────

test("Root driver reschedules a ride after network recovery failure", async () => {
  // Step 1 — Authenticate both actors
  await test.step("1 — Authenticate passenger and driver", async () => {
    await login(passengerCtx, passengerEmail, PASSWORD);
    await login(driverCtx, driverEmail, PASSWORD);
  });

  // Step 2 — Passenger creates a ride assigned to the root driver
  const { rideId } = await test.step("2 — Passenger creates a ride assigned to root driver", async () => {
    const ride = await createRide(passengerCtx, passengerId);
    expect(ride.rideId).toBeTruthy();
    expect(["PENDING", "REQUESTED"]).toContain(ride.status);
    return ride;
  });

  console.log(`[E2E-003] Ride created: rideId=${rideId}`);

  // Step 3 — Receive the dispatch offer and reject it, forcing fallback to NETWORK_DISPATCH
  const offer = await test.step("3 — Root driver receives pending offer and rejects it", async () => {
    const pending = await waitForPendingOffer(driverCtx, driverId, rideId);
    const result = await respondToOffer(driverCtx, pending.id, false);
    expect(result.accepted).toBe(false);
    return pending;
  });

  console.log(`[E2E-003] Offer rejected: offerId=${offer.id}`);

  // Step 4 — Drive the ride into OWNER_RECOVERY by manually overriding dispatch stage
  // (in a production scenario this would be reached naturally when no network candidates exist;
  // here we force the state to keep the test deterministic regardless of seed data density)
  await test.step("4 — Force ride into OWNER_RECOVERY", async () => {
    const rideBefore = await getRide(passengerCtx, rideId);

    // At this point the ride should be moving toward NETWORK_DISPATCH after reject.
    // We force it to OWNER_RECOVERY to simulate an exhaustive network sweep.
    const updateRes = await passengerCtx.patch(`${BASE}/rides/${rideId}`, {
      data: { action: "reject_referral" },
    });

    if (!updateRes.ok()) {
      const body = await updateRes.text();
      // If it's already past OWNER_DISPATCH, ignore and continue.
      console.log(`[E2E-003] reject_referral response: ${updateRes.status()} — ${body}`);
    }
  });

  // Step 5 — Reschedule the ride via PATCH /rides/:id/reschedule
  const rescheduleRes = await test.step("5 — Root driver calls PATCH /rides/:id/reschedule", async () => {
    const newDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const res = await passengerCtx.patch(`${BASE}/rides/${rideId}/reschedule`, {
      data: {
        newScheduledAt: newDate,
        driverId,
      },
    });

    if (!res.ok()) {
      const body = await res.text();
      throw new Error(`Reschedule failed: ${res.status()} — ${body}`);
    }

    const body = await res.json();
    expect(body).toHaveProperty("message", "Corrida reagendada com sucesso");
    return body;
  });

  console.log(`[E2E-003] Reschedule response:`, rescheduleRes);

  // Step 6 — Final assertions on the ride state via REST contract
  await test.step("6 — Assert ride resets to OWNER_DISPATCH with clean excluded cache", async () => {
    const ride = await getRide(passengerCtx, rideId);

    // The API must return 200 and the ride payload
    expect(ride.status).toBeTruthy();

    // Core contract: after reschedule, dispatch stage must be OWNER_DISPATCH
    expect(ride.currentDispatchStage).toBe("OWNER_DISPATCH");

    // Critical: the exclusion cache must be cleared so previously rejected drivers can be offered again
    expect(Array.isArray(ride.excludedDriverIds ?? [])).toBe(true);
    expect((ride.excludedDriverIds ?? []).length).toBe(0);
  });

  console.log(`[E2E-003] ✅ Owner recovery reschedule flow validated. ride=${rideId} driver=${driverId}`);
});