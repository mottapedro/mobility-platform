import { test, expect, APIRequestContext, request as playwrightRequest } from "@playwright/test";

/**
 * E2E-004: Ride Execution — Start and Complete Flow.
 *
 * Self-contained semantic contract test for the ride execution endpoints:
 * - POST /rides/:id/start (ACCEPTED → IN_PROGRESS)
 * - POST /rides/:id/complete (IN_PROGRESS → COMPLETED)
 *
 * Reuses the E2E-001 setup pattern to create fresh actors, drives a ride to
 * ACCEPTED, executes start and complete, and asserts state transitions.
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
): Promise<string> {
  const res = await ctx.post(`${BASE}/auth/login`, {
    data: { email, password },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Login failed for ${email}: ${res.status()} — ${body}`);
  }
  const body = await res.json();
  return body.accessToken as string;
}

async function createRide(
  ctx: APIRequestContext,
  passengerId: string,
  origin = "Rua A, 123",
  destination = "Rua B, 456",
  originLat = -22.958,
  originLng = -43.263,
  destinationLat = -22.906,
  destinationLng = -43.172
): Promise<{ rideId: string; status: string; currentDispatchStage?: string }> {
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const res = await ctx.post(`${BASE}/rides`, {
    data: {
      passengerId,
      origin,
      destination,
      scheduledAt,
      originLat,
      originLng,
      destinationLat,
      destinationLng,
    },
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
): Promise<{ status: string; selectedDriverId: string | null; currentDispatchStage?: string }> {
  const res = await ctx.get(`${BASE}/rides/${rideId}`, {
    headers: { Authorization: `Bearer ${passengerAccessToken}` },
  });

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
      console.log(`[E2E-004] Pending offer found for driver=${driverId}: ${match.id}`);
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

async function startRide(
  ctx: APIRequestContext,
  rideId: string,
  driverId: string
): Promise<{ message: string; ride: { status: string; selectedDriverId: string | null } }> {
  const res = await ctx.post(`${BASE}/rides/${rideId}/start`, {
    data: { driverId },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Start ride failed: ${res.status()} — ${body}`);
  }

  return res.json();
}

async function mockConfirmPayment(
  ctx: APIRequestContext,
  rideId: string,
  amountCents: number
): Promise<{ id: string; status: string; externalId: string }> {
  const res = await ctx.post(`${BASE}/test/confirm-payment`, {
    data: { rideId, amountCents },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Mock confirm payment failed: ${res.status()} — ${body}`);
  }

  return res.json();
}

async function completeRide(
  ctx: APIRequestContext,
  rideId: string,
  driverId: string
): Promise<{ message: string; ride: { status: string; selectedDriverId: string | null } }> {
  const res = await ctx.post(`${BASE}/rides/${rideId}/complete`, {
    data: { driverId },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Complete ride failed: ${res.status()} — ${body}`);
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
let passengerAccessToken: string;
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
  const driver = await registerDriver(driverCtx, driverEmail, PASSWORD, "E2E Execution Driver", "21900000002");
  driverId = driver.driverId;

  const passenger = await registerPassenger(
    passengerCtx,
    passengerEmail,
    PASSWORD,
    "E2E Execution Passenger",
    "21900000001",
    driver.referralCode
  );
  passengerId = passenger.passengerId;

  console.log(`[E2E-004] Actors: passenger=${passengerId} (${passengerEmail}) driver=${driverId} (${driverEmail}) rootDriverId=${passenger.rootDriverId}`);
});

test.afterAll(async () => {
  await passengerCtx.dispose();
  await driverCtx.dispose();
});

// ─── Scenario: Create ride → Accept → Start → Complete ──────────────────────

test("Driver accepts, starts, and completes a ride through the full execution lifecycle", async () => {
  // Step 1 — Authenticate both actors
  await test.step("1 — Authenticate passenger and driver", async () => {
    passengerAccessToken = await login(passengerCtx, passengerEmail, PASSWORD);
    await login(driverCtx, driverEmail, PASSWORD);
  });

  // Step 2 — Passenger creates a ride assigned to the root driver
  const { rideId } = await test.step("2 — Passenger creates a ride assigned to root driver", async () => {
    const ride = await createRide(passengerCtx, passengerId);
    expect(ride.rideId).toBeTruthy();
    expect(["PENDING", "REQUESTED"]).toContain(ride.status);
    return ride;
  });

  console.log(`[E2E-004] Ride created: rideId=${rideId}`);

  // Step 3 — Driver receives and accepts the offer, transitioning to ACCEPTED
  const offer = await test.step("3 — Root driver receives pending offer and accepts it", async () => {
    const pending = await waitForPendingOffer(driverCtx, driverId, rideId);
    const result = await respondToOffer(driverCtx, pending.id, true);
    expect(result.accepted).toBe(true);
    return pending;
  });

  console.log(`[E2E-004] Offer accepted: offerId=${offer.id}`);

  // Step 3.1 — Mock payment confirmation (PicPay webhook simulado para Sprint 2)
  const paymentAmountCents = 1500; // R$ 15,00
  await test.step("3.1 — Mock payment confirmation", async () => {
    const payment = await mockConfirmPayment(passengerCtx, rideId, paymentAmountCents);
    console.log(`[E2E-004] Mock payment confirmed: paymentId=${payment.id} status=${payment.status} externalId=${payment.externalId}`);
  });

  // Poll until the ride reaches ACCEPTED status
  await test.step("4 — Wait for ride to become ACCEPTED", async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const ride = await getRide(passengerCtx, rideId);
      if (ride.status === "ACCEPTED") {
        console.log(`[E2E-004] Ride is ACCEPTED: rideId=${rideId}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Timeout waiting for ACCEPTED status: rideId=${rideId}`);
  });

  const acceptedRide = await getRide(passengerCtx, rideId);
  expect(acceptedRide.status).toBe("ACCEPTED");
  expect(acceptedRide.selectedDriverId).toBe(driverId);

  // Step 5 — Start the ride (ACCEPTED → IN_PROGRESS)
  await test.step("5 — Driver starts the ride", async () => {
    const startResult = await startRide(driverCtx, rideId, driverId);
    expect(startResult.message).toBe("Corrida iniciada com sucesso");
    expect(startResult.ride.status).toBe("IN_PROGRESS");
  });

  // Verify state transition via REST
  const startedRide = await getRide(passengerCtx, rideId);
  expect(startedRide.status).toBe("IN_PROGRESS");

  console.log(`[E2E-004] Ride started: rideId=${rideId} status=IN_PROGRESS`);

  // Step 6 — Complete the ride (IN_PROGRESS → COMPLETED)
  await test.step("6 — Driver completes the ride", async () => {
    const completeResult = await completeRide(driverCtx, rideId, driverId);
    expect(completeResult.message).toBe("Corrida finalizada com sucesso");
    expect(completeResult.ride.status).toBe("COMPLETED");
  });

  // Verify final state via REST
  const completedRide = await getRide(passengerCtx, rideId);
  expect(completedRide.status).toBe("COMPLETED");

  console.log(`[E2E-004] Ride completed: rideId=${rideId} status=COMPLETED`);

  // Step 7 — Security test: unauthorized driver cannot complete an already completed ride
  await test.step("7 — Security: another driver cannot modify a completed ride", async () => {
    // Create a second driver to attempt unauthorized completion
    const fakeDriverEmail = `e2e.fake.${Date.now()}@test.com`;
    const fakeDriver = await registerDriver(driverCtx, fakeDriverEmail, PASSWORD, "Fake Driver", "21900000003");
    const fakeDriverId = fakeDriver.driverId;
    await login(driverCtx, fakeDriverEmail, PASSWORD);

    // Try to start the already-completed ride with the fake driver — should fail
    const unauthorizedRes = await driverCtx.post(`${BASE}/rides/${rideId}/start`, {
      data: { driverId: fakeDriverId },
    });

    // Expect failure (401/403/400) because selectedDriverId mismatch and/or invalid status
    expect(unauthorizedRes.ok()).toBe(false);

    const body = await unauthorizedRes.text();
    console.log(`[E2E-004] Security test response: ${unauthorizedRes.status()} — ${body}`);
    expect(body).toContain("Unauthorized");
  });

  console.log(`[E2E-004] ✅ Full ride execution lifecycle validated. ride=${rideId} driver=${driverId}`);
});
