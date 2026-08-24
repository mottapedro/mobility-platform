/**
 * E2E — Referral Matching Flow
 *
 * Requires the server running on http://localhost:3000 with NODE_ENV !== "production".
 * Run with: npm run test:e2e
 *
 * Before each scenario the database is wiped via POST /test/reset and fresh
 * actors are registered, so no seed data is required.
 */

import { test, expect, APIRequestContext, request as playwrightRequest } from "@playwright/test";

const BASE = "http://localhost:3000";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function login(
  ctx: APIRequestContext,
  email: string,
  password: string
): Promise<{ userId: string; driverId?: string; passengerId?: string; role: string; accessToken: string }> {
  const res = await ctx.post(`${BASE}/auth/login`, {
    data: { email, password },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Login failed for ${email}: ${res.status()} — ${body}`);
  }

  const body = await res.json();
  console.log(`[login] ✅ ${email} → role=${body.user.role} | driverId=${body.driverId} | passengerId=${body.passengerId}`);
  return {
    userId: body.user.id,
    driverId: body.driverId,
    passengerId: body.passengerId,
    role: body.user.role,
    accessToken: body.accessToken,
  };
}

async function createRide(
  ctx: APIRequestContext,
  passengerId: string,
  origin = "Barra da Tijuca",
  destination = "Aeroporto Galeão",
  offsetMs = 3_600_000
): Promise<{ rideId: string; status: string }> {
  const scheduledAt = new Date(Date.now() + offsetMs).toISOString();

  const res = await ctx.post(`${BASE}/rides`, {
    data: { passengerId, origin, destination, scheduledAt },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`createRide failed: ${res.status()} — ${body}`);
  }

  const body = await res.json();
  // Response shape: { message, ride: { id, status, ... } }
  const rideId = body.ride?.id ?? body.id;
  const status = body.ride?.status ?? body.status;

  console.log(`[createRide] ✅ rideId=${rideId} status=${status}`);
  return { rideId, status };
}

async function getDriverOffers(
  ctx: APIRequestContext,
  driverId: string
): Promise<Array<{ id: string; rideRequestId: string; status: string }>> {
  const res = await ctx.get(`${BASE}/drivers/${driverId}/offers`, {
    headers: { "x-driver-id": driverId },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`getDriverOffers failed for ${driverId}: ${res.status()} — ${body}`);
  }

  return res.json();
}

/**
 * Polls GET /drivers/:driverId/offers until a PENDING offer for rideId appears,
 * or throws after maxWaitMs.
 */
async function waitForOffer(
  ctx: APIRequestContext,
  driverId: string,
  rideId: string,
  maxWaitMs = 10_000,
  intervalMs = 400
): Promise<{ id: string; rideRequestId: string; status: string }> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const offers = await getDriverOffers(ctx, driverId);
    const match = offers.find((o) => o.rideRequestId === rideId && o.status === "PENDING");

    if (match) {
      console.log(`[waitForOffer] ✅ driver=${driverId} → offer=${match.id}`);
      return match;
    }

    console.log(`[waitForOffer] ⏳ driver=${driverId} → sem offer para ${rideId}, aguardando...`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`[waitForOffer] ⏰ Timeout: nenhum offer para rideId=${rideId} driver=${driverId} em ${maxWaitMs}ms`);
}

async function respondToOffer(
  ctx: APIRequestContext,
  offerId: string,
  accept: boolean
): Promise<{ accepted: boolean; message: string }> {
  const res = await ctx.patch(`${BASE}/offers/${offerId}/respond`, {
    data: { accept },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`respondToOffer(${offerId}, ${accept}) failed: ${res.status()} — ${body}`);
  }

  const body = await res.json();
  console.log(`[respondToOffer] ✅ offer=${offerId} accept=${accept} → "${body.message}"`);
  return body;
}

async function getRideStatus(
  ctx: APIRequestContext,
  rideId: string
): Promise<{ status: string; selectedDriverId: string | null }> {
  const res = await ctx.get(`${BASE}/rides/${rideId}`, {
    headers: { Authorization: `Bearer ${passengerAccessToken}` },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`getRideStatus(${rideId}) failed: ${res.status()} — ${body}`);
  }

  const body = await res.json();
  // Response shape may be { ride: {...} } or the object directly
  const ride = body.ride ?? body;
  return { status: ride.status, selectedDriverId: ride.selectedDriverId ?? null };
}

// ─── Test setup ─────────────────────────────────────────────────────────────

let passengerCtx: APIRequestContext;
let pedroCtx: APIRequestContext;
let joaoCtx: APIRequestContext;

let passengerId: string;
let pedroDriverId: string;
let joaoDriverId: string;
let pedroReferralCode: string;
let passengerAccessToken: string;

async function getPublicDriverProfile(
  ctx: APIRequestContext,
  referralCode: string
): Promise<{ name: string; referralCode: string }> {
  const res = await ctx.get(`${BASE}/public/drivers/${referralCode}`);

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`getPublicDriverProfile failed for ${referralCode}: ${res.status()} — ${body}`);
  }

  return res.json();
}

async function resolveReferralSlug(
  ctx: APIRequestContext,
  slug: string
): Promise<{ slug: string; referralCode: string }> {
  const res = await ctx.get(`${BASE}/r/${slug}`);

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`resolveReferralSlug failed for ${slug}: ${res.status()} — ${body}`);
  }

  return res.json();
}

test.beforeAll(async () => {
  passengerCtx = await playwrightRequest.newContext({ baseURL: BASE });
  pedroCtx     = await playwrightRequest.newContext({ baseURL: BASE });
  joaoCtx      = await playwrightRequest.newContext({ baseURL: BASE });
});

/**
 * Before each scenario: wipe the database and register fresh actors so there
 * is no state leakage between tests.
 */
test.beforeEach(async () => {
  // 1. Wipe all data
  const resetRes = await passengerCtx.post(`${BASE}/test/reset`);
  if (!resetRes.ok()) {
    throw new Error(`DB reset failed: ${resetRes.status()} — ${await resetRes.text()}`);
  }

  // 2. Register Pedro as a driver (no referrer)
  const pedroReg = await pedroCtx.post(`${BASE}/auth/register`, {
    data: { name: "Pedro Motta", email: "pedro@e2e.test", password: "123456", role: "driver", phone: "21900000001" },
  });
  if (!pedroReg.ok()) throw new Error(`Pedro register: ${await pedroReg.text()}`);
  const pedroBody = await pedroReg.json();
  pedroDriverId = pedroBody.driverId;
  pedroReferralCode = pedroBody.referralCode;

  const pedroPublicProfile = await getPublicDriverProfile(passengerCtx, pedroReferralCode);
  expect(pedroPublicProfile.referralCode).toBe(pedroReferralCode);
  const pedroCanonicalProfile = await resolveReferralSlug(passengerCtx, pedroReferralCode);
  expect(pedroCanonicalProfile.referralCode).toBe(pedroReferralCode);

  // 3. Register João as a driver referred by Pedro (creates L1 referral chain)
  const joaoReg = await joaoCtx.post(`${BASE}/auth/register`, {
    data: { name: "João Brito", email: "joao@e2e.test", password: "123456", role: "driver", phone: "21900000002", referralCode: pedroReferralCode },
  });
  if (!joaoReg.ok()) throw new Error(`João register: ${await joaoReg.text()}`);
  joaoDriverId = (await joaoReg.json()).driverId;

  // 4. Register a test passenger referred by Pedro
  const passReg = await passengerCtx.post(`${BASE}/auth/register`, {
    data: { name: "Test Passenger", email: "passenger@e2e.test", password: "123456", role: "passenger", phone: "21900000003", referralCode: pedroReferralCode },
  });
  if (!passReg.ok()) throw new Error(`Passenger register: ${await passReg.text()}`);
  const passBody = await passReg.json();
  passengerId = passBody.passengerId;
  passengerAccessToken = passBody.accessToken;

  console.log(`\n📋 Actors (fresh):`);
  console.log(`   Test Passenger: ${passengerId} (referred by Pedro)`);
  console.log(`   Driver Pedro:   ${pedroDriverId}`);
  console.log(`   Driver João:    ${joaoDriverId} (referred by Pedro = L1)\n`);
});

test.afterAll(async () => {
  await passengerCtx.dispose();
  await pedroCtx.dispose();
  await joaoCtx.dispose();
});

// ─── Scenario 1 — Referral rejects → fallback → João accepts ────────────────

test("Scenario 1 — Referral rejects, fallback driver (L1) accepts", async () => {
  // Step 1.1 — Passenger creates a ride
  const { rideId, status: initialStatus } = await test.step(
    "1.1 — Passenger creates a ride → WAITING_REFERRAL",
    async () => {
      const ride = await createRide(passengerCtx, passengerId, "Barra da Tijuca", "Aeroporto Galeão");
      expect(ride.status).toBe("WAITING_REFERRAL");
      return ride;
    }
  );

  // Step 1.2 — Pedro (referred driver) receives the offer
  const pedroOffer = await test.step(
    "1.2 — Pedro receives the referral offer",
    async () => {
      const offer = await waitForOffer(pedroCtx, pedroDriverId, rideId);
      expect(offer).toBeDefined();
      return offer;
    }
  );

  // Step 1.3 — João has no offer yet
  await test.step(
    "1.3 — João has NO offer (offer is exclusive to Pedro)",
    async () => {
      const offers = await getDriverOffers(joaoCtx, joaoDriverId);
      const related = offers.filter((o) => o.rideRequestId === rideId && o.status === "PENDING");
      expect(related).toHaveLength(0);
    }
  );

  // Step 1.4 — Pedro rejects
  await test.step("1.4 — Pedro rejects the offer", async () => {
    const result = await respondToOffer(pedroCtx, pedroOffer.id, false);
    expect(result.accepted).toBe(false);
  });

  // Step 1.5 — João receives the fallback offer (NETWORK_L1)
  const joaoOffer = await test.step(
    "1.5 — João (L1 network) receives offer after rejection",
    async () => {
      const offer = await waitForOffer(joaoCtx, joaoDriverId, rideId, 8_000);
      expect(offer).toBeDefined();
      return offer;
    }
  );

  // Step 1.6 — João accepts
  await test.step("1.6 — João accepts the offer", async () => {
    const result = await respondToOffer(joaoCtx, joaoOffer.id, true);
    expect(result.accepted).toBe(true);
  });

  // Step 1.7 — Ride is ACCEPTED with João as selectedDriverId
  await test.step("1.7 — Ride status is ACCEPTED, selectedDriverId = João", async () => {
    const ride = await getRideStatus(passengerCtx, rideId);
    expect(ride.status).toBe("ACCEPTED");
    expect(ride.selectedDriverId).toBe(joaoDriverId);
  });
});

// ─── Scenario 2 — Referral accepts directly, João gets no offer ─────────────

test("Scenario 2 — Referred driver accepts directly", async () => {
  // Step 2.1 — Passenger creates a second ride (offset +90min to avoid conflict)
  const { rideId } = await test.step(
    "2.1 — Passenger creates a second ride → WAITING_REFERRAL",
    async () => {
      const ride = await createRide(
        passengerCtx,
        passengerId,
        "Barra da Tijuca",
        "Centro do Rio"
      );
      expect(ride.status).toBe("WAITING_REFERRAL");
      return ride;
    }
  );

  // Step 2.2 — Pedro receives the offer
  const pedroOffer = await test.step(
    "2.2 — Pedro receives the referral offer",
    async () => {
      const offer = await waitForOffer(pedroCtx, pedroDriverId, rideId);
      expect(offer).toBeDefined();
      return offer;
    }
  );

  // Step 2.3 — Pedro accepts
  await test.step("2.3 — Pedro accepts the offer directly", async () => {
    const result = await respondToOffer(pedroCtx, pedroOffer.id, true);
    expect(result.accepted).toBe(true);
  });

  // Step 2.4 — Ride ACCEPTED with Pedro
  await test.step("2.4 — Ride status is ACCEPTED, selectedDriverId = Pedro", async () => {
    const ride = await getRideStatus(passengerCtx, rideId);
    expect(ride.status).toBe("ACCEPTED");
    expect(ride.selectedDriverId).toBe(pedroDriverId);
  });

  // Step 2.5 — João receives no offer
  await test.step("2.5 — João has no offer for this ride", async () => {
    const offers = await getDriverOffers(joaoCtx, joaoDriverId);
    const related = offers.filter(
      (o) => o.rideRequestId === rideId && o.status === "PENDING"
    );
    expect(related).toHaveLength(0);
  });
});
