import { test, expect, request as playwrightRequest, APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { validateTarget } from "../../scripts/e2e/supabase-target.cjs";
import { matchingJobScheduler } from "../../src/infra/async/MatchingJobScheduler";
import { referralFallbackScheduler } from "../../src/infra/async/ReferralFallbackScheduler";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const namespace = process.env.M3_2_TEST_RUN_NAMESPACE?.trim();
let prisma: PrismaClient;

type OwnedIds = {
  userIds: string[];
  driverIds: string[];
  passengerIds: string[];
  driverReferralIds: string[];
  referralRelationshipIds: string[];
  rideIds: string[];
  offerIds: string[];
  domainEventIds: string[];
  paymentIntentIds: string[];
};

const owned: OwnedIds = {
  userIds: [], driverIds: [], passengerIds: [], driverReferralIds: [], referralRelationshipIds: [], rideIds: [], offerIds: [],
  domainEventIds: [], paymentIntentIds: [],
};

function requireTestBoundary(): void {
  if (!namespace || !/^m3-2-[a-z0-9-]+$/i.test(namespace)) throw new Error("M3_2_NAMESPACE_REQUIRED");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
  const target = validateTarget(process.env.DATABASE_URL);
  if (!process.env.E2E_CA_CERT) throw new Error("E2E_CA_CERT_REQUIRED");
  if (!process.env.PRISMA_MIGRATIONS_PATH) throw new Error("PRISMA_MIGRATIONS_PATH_REQUIRED");
  const root = path.resolve(__dirname, "../..");
  execFileSync(process.execPath, [path.join(root, "scripts/e2e/verify-authorized-migration-artifact.cjs"), process.env.PRISMA_MIGRATIONS_PATH], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [path.join(root, "scripts/e2e/migration-safety-audit.cjs"), "--certify-final"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (!target.projectRef) throw new Error("E2E_TARGET_PROJECT_REQUIRED");
  prisma = new PrismaClient();
}

async function register(ctx: APIRequestContext, role: "driver" | "passenger", label: string, referralCode?: string) {
  const email = `${namespace}.${label}@test.com`;
  const response = await ctx.post(`${BASE}/auth/register`, {
    data: {
      name: `${namespace}-${label}`,
      email,
      password: "m3-2-e2e-password",
      role,
      phone: `219${String(Date.now()).slice(-8)}`,
      ...(referralCode ? { referralCode } : {}),
    },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  if (typeof body.user?.id !== "string") throw new Error("REGISTER_RESPONSE_USER_ID_REQUIRED");
  owned.userIds.push(body.user.id);
  if (role === "driver") owned.driverIds.push(body.driverId);
  else owned.passengerIds.push(body.passengerId);
  return body;
}

async function offers(ctx: APIRequestContext, token: string, driverId: string, rideId: string) {
  const response = await ctx.get(`${BASE}/drivers/${driverId}/offers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBe(true);
  const rows = await response.json();
  return rows.filter((row: { rideRequestId: string; status: string }) => row.rideRequestId === rideId);
}

async function waitForPending(ctx: APIRequestContext, token: string, driverId: string, rideId: string) {
  await expect.poll(async () => (await offers(ctx, token, driverId, rideId)).filter((row: { status: string }) => row.status === "PENDING").length, { timeout: 10000 }).toBe(1);
  return (await offers(ctx, token, driverId, rideId)).find((row: { status: string }) => row.status === "PENDING");
}

async function captureOwnedDerivedRecords(): Promise<void> {
  const foreign = await prisma.rideRequest.count({ where: { id: { in: owned.rideIds }, passenger: { userId: { not: { in: owned.userIds } } } } });
  if (foreign !== 0) throw new Error("M3_2_FOREIGN_OWNERSHIP_DETECTED");
  const foreignOffers = await prisma.rideOffer.count({ where: { rideRequestId: { in: owned.rideIds }, driverId: { not: { in: owned.driverIds } } } });
  if (foreignOffers !== 0) throw new Error("M3_2_FOREIGN_OFFER_OWNERSHIP_DETECTED");
  const relationships = await prisma.referralRelationship.findMany({
    where: { OR: [{ inviterDriverId: { in: owned.driverIds } }, { invitedId: { in: [...owned.driverIds, ...owned.passengerIds] } }] },
    select: { id: true, inviterDriverId: true, invitedId: true, rootDriverId: true },
  });
  if (relationships.some((row) => row.rootDriverId !== owned.driverIds[0] || (row.inviterDriverId && !owned.driverIds.includes(row.inviterDriverId)) || ![...owned.driverIds, ...owned.passengerIds].includes(row.invitedId))) {
    throw new Error("M3_2_FOREIGN_RELATIONSHIP_OWNERSHIP_DETECTED");
  }
  owned.referralRelationshipIds.push(...relationships.map((row) => row.id));
  const driverReferrals = await prisma.driverReferral.findMany({ where: { referrerDriverId: { in: owned.driverIds }, referredDriverId: { in: owned.driverIds } }, select: { id: true } });
  owned.driverReferralIds.push(...driverReferrals.map((row) => row.id));
  const offers = await prisma.rideOffer.findMany({ where: { rideRequestId: { in: owned.rideIds } }, select: { id: true } });
  const events = await prisma.domainEvent.findMany({ where: { aggregateId: { in: [...owned.rideIds, ...offers.map((row) => row.id)] } }, select: { id: true } });
  const intents = await prisma.paymentIntent.findMany({ where: { rideRequestId: { in: owned.rideIds } }, select: { id: true } });
  owned.offerIds.push(...offers.map((row) => row.id));
  owned.domainEventIds.push(...events.map((row) => row.id));
  owned.paymentIntentIds.push(...intents.map((row) => row.id));
}

function freezeOwnership(): Readonly<OwnedIds> {
  return Object.freeze({
    userIds: [...owned.userIds], driverIds: [...owned.driverIds], passengerIds: [...owned.passengerIds],
    driverReferralIds: [...owned.driverReferralIds], referralRelationshipIds: [...owned.referralRelationshipIds],
    rideIds: [...owned.rideIds], offerIds: [...owned.offerIds], domainEventIds: [...owned.domainEventIds],
    paymentIntentIds: [...owned.paymentIntentIds],
  });
}

async function cleanupOwned(frozen: Readonly<OwnedIds>): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.rideOffer.deleteMany({ where: { id: { in: frozen.offerIds } } });
    await tx.paymentIntent.deleteMany({ where: { id: { in: frozen.paymentIntentIds } } });
    await tx.domainEvent.deleteMany({ where: { id: { in: frozen.domainEventIds } } });
    await tx.rideRequest.deleteMany({ where: { id: { in: frozen.rideIds } } });
    await tx.referralRelationship.deleteMany({ where: { id: { in: frozen.referralRelationshipIds } } });
    await tx.driverReferral.deleteMany({ where: { id: { in: frozen.driverReferralIds } } });
    await tx.passenger.deleteMany({ where: { id: { in: frozen.passengerIds } } });
    await tx.driver.deleteMany({ where: { id: { in: frozen.driverIds } } });
    await tx.user.deleteMany({ where: { id: { in: frozen.userIds } } });
  });
}

async function quiesceOwnedRuntime(): Promise<void> {
  for (const rideId of owned.rideIds) {
    await Promise.all([
      matchingJobScheduler.quiesceForRide(rideId),
      referralFallbackScheduler.quiesceForRide(rideId),
    ]);
    const active = matchingJobScheduler.pendingCountForRide(rideId)
      + referralFallbackScheduler.pendingTimerCountForRide(rideId)
      + referralFallbackScheduler.inflightCountForRide(rideId);
    if (active !== 0) throw new Error(`M3_2_ACTIVE_CALLBACKS_REMAIN: ${rideId}`);
  }
}

test.describe("M3.2 governed 4B3 network capability", () => {
  let passengerCtx: APIRequestContext;
  let ownerCtx: APIRequestContext;
  let networkCtx: APIRequestContext;
  let owner: { driverId: string; referralCode: string; accessToken: string };
  let network: { driverId: string; accessToken: string };
  let passenger: { passengerId: string; accessToken: string };

  test.beforeAll(async () => {
    requireTestBoundary();
    passengerCtx = await playwrightRequest.newContext({ baseURL: BASE });
    ownerCtx = await playwrightRequest.newContext({ baseURL: BASE });
    networkCtx = await playwrightRequest.newContext({ baseURL: BASE });
  });

  test.afterAll(async () => {
    await Promise.all([passengerCtx?.dispose(), ownerCtx?.dispose(), networkCtx?.dispose()]);
    await prisma?.$disconnect();
  });

  test("owner rejection falls back to network candidate", async () => {
    try {
      owner = await register(ownerCtx, "driver", "owner");
      network = await register(networkCtx, "driver", "network", owner.referralCode);
      passenger = await register(passengerCtx, "passenger", "passenger", owner.referralCode);

    const rideResponse = await passengerCtx.post(`${BASE}/rides`, {
      data: { passengerId: passenger.passengerId, origin: "Barra da Tijuca", destination: "Centro do Rio", scheduledAt: new Date(Date.now() + 3600000).toISOString() },
    });
    expect(rideResponse.ok()).toBe(true);
    const ride = await rideResponse.json();
    const rideId = ride.ride?.id ?? ride.id;
    owned.rideIds.push(rideId);

    const first = await waitForPending(ownerCtx, owner.accessToken, owner.driverId, rideId);
    owned.offerIds.push(first.id);
    expect((await offers(networkCtx, network.accessToken, network.driverId, rideId)).filter((row: { status: string }) => row.status === "PENDING")).toHaveLength(0);

    const reject = await ownerCtx.patch(`${BASE}/offers/${first.id}/respond`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` }, data: { accept: false },
    });
    expect(reject.ok()).toBe(true);

    const fallback = await waitForPending(networkCtx, network.accessToken, network.driverId, rideId);
    owned.offerIds.push(fallback.id);
    expect(fallback.driverId).toBe(network.driverId);
    expect((await offers(ownerCtx, owner.accessToken, owner.driverId, rideId)).filter((row: { status: string }) => row.status === "PENDING")).toHaveLength(0);

    const accepted = await networkCtx.patch(`${BASE}/offers/${fallback.id}/respond`, {
      headers: { Authorization: `Bearer ${network.accessToken}` }, data: { accept: true },
    });
    expect(accepted.ok()).toBe(true);

    const rideState = await prisma.rideRequest.findUnique({ where: { id: rideId }, select: { status: true, selectedDriverId: true, excludedDriverIds: true } });
    expect(rideState?.status).toBe("ACCEPTED");
    expect(rideState?.selectedDriverId).toBe(network.driverId);
    expect(rideState?.excludedDriverIds).toContain(owner.driverId);
      const pending = await prisma.rideOffer.count({ where: { rideRequestId: rideId, status: "PENDING" } });
      expect(pending).toBe(0);
    } finally {
      try {
        await captureOwnedDerivedRecords();
        const frozen = freezeOwnership();
        await quiesceOwnedRuntime();
        await cleanupOwned(frozen);
      } finally {
        await Promise.all([passengerCtx?.dispose(), ownerCtx?.dispose(), networkCtx?.dispose()]);
        await prisma?.$disconnect();
      }
    }
  });
});
