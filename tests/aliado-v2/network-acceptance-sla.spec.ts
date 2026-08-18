/**
 * Network Acceptance SLA — 15-minute offer window for network-owned rides
 *
 * Feature: immediate network-owned rides (passenger.rootDriverId set) use a
 * 15-min acceptance window instead of the default 2-min immediate window.
 * Scheduled rides (>24h ahead) already have a 30-min window which exceeds the
 * network SLA, so they are unaffected (Math.max(30, 15) = 30).
 *
 * Unit tests (1-4): validate AcceptancePolicyEngine in isolation, no DB.
 * Integration tests (5-8): verify that MatchRideUseCase wires isNetworkOwned
 * correctly and that offers are created with the engine-computed expiresAt.
 */

import bcrypt from "bcrypt";
import { prisma, cleanTestData } from "../setup";
import {
  AcceptancePolicyEngine,
  IMMEDIATE_OFFER_TIMEOUT_MS,
  NETWORK_OFFER_TIMEOUT_MS,
  SCHEDULED_OFFER_TIMEOUT_MS,
} from "../../src/domain/services/AcceptancePolicyEngine";
import { MatchRideUseCase } from "../../src/application/use-cases/MatchRideUseCase";

const hash = (pw: string) => bcrypt.hash(pw, 4);
const SLA_DOMAIN = "@sla.com";

async function makeDriver(tag: string) {
  const email = `sla.driver.${tag}${SLA_DOMAIN}`;
  const user = await prisma.user.create({
    data: {
      name: `SLA Driver ${tag}`,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await hash("pass"),
    },
  });
  return prisma.driver.create({
    data: {
      userId: user.id,
      isActive: true,
      experienceLevel: "PROFISSIONAL",
      regions: ["Intermunicipal"],
      referralCode: `sla-rc-${tag}-${Date.now()}`,
      publicSlug: `sla-slug-${tag}-${Date.now()}`,
    },
  });
}

async function makePassenger(tag: string, rootDriverId: string | null = null) {
  const email = `sla.pass.${tag}${SLA_DOMAIN}`;
  const user = await prisma.user.create({
    data: {
      name: `SLA Passenger ${tag}`,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
      passwordHash: await hash("pass"),
    },
  });
  return prisma.passenger.create({
    data: {
      userId: user.id,
      rootDriverId,
      referralCode: `sla-p-rc-${tag}-${Date.now()}`,
      publicSlug: `sla-p-slug-${tag}-${Date.now()}`,
    },
  });
}

// scheduledAt must be >= 24h ahead to pass the operationalCutoff guard.
const SCHEDULED_AT = () => new Date(Date.now() + 48 * 60 * 60 * 1000);

async function makeRide(passengerId: string, rootDriverId: string | null = null) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      origin: "Rua Teste, 1",
      destination: "Av. Destino, 100",
      scheduledAt: SCHEDULED_AT(),
      status: "PENDING",
      rootDriverId,
    },
  });
}

// --- Unit tests: AcceptancePolicyEngine ---

describe("AcceptancePolicyEngine - network SLA (unit)", () => {
  test("1. immediate + network-owned: offerResponseTimeoutMs = 15 min", () => {
    const policy = AcceptancePolicyEngine.computePolicy(null, true);
    expect(policy.offerResponseTimeoutMs).toBe(NETWORK_OFFER_TIMEOUT_MS);
    expect(policy.offerResponseTimeoutMs).toBe(15 * 60 * 1000);
    expect(policy.isNetworkOwned).toBe(true);
    expect(policy.isScheduled).toBe(false);
  });

  test("2. immediate + public: offerResponseTimeoutMs = 2 min (no regression)", () => {
    const policy = AcceptancePolicyEngine.computePolicy(null, false);
    expect(policy.offerResponseTimeoutMs).toBe(IMMEDIATE_OFFER_TIMEOUT_MS);
    expect(policy.offerResponseTimeoutMs).toBe(2 * 60 * 1000);
    expect(policy.isNetworkOwned).toBe(false);
  });

  test("3. scheduled + network-owned: 30 min (Math.max keeps larger window)", () => {
    const scheduledAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const policy = AcceptancePolicyEngine.computePolicy(scheduledAt, true);
    expect(policy.offerResponseTimeoutMs).toBe(SCHEDULED_OFFER_TIMEOUT_MS);
    expect(policy.offerResponseTimeoutMs).toBe(30 * 60 * 1000);
    expect(policy.isNetworkOwned).toBe(true);
    expect(policy.isScheduled).toBe(true);
  });

  test("4. isNetworkOwned omitted: public behaviour (default false)", () => {
    const policy = AcceptancePolicyEngine.computePolicy(null);
    expect(policy.offerResponseTimeoutMs).toBe(IMMEDIATE_OFFER_TIMEOUT_MS);
    expect(policy.isNetworkOwned).toBe(false);
  });

  test("short-notice scheduled (<24h ahead): cutoff clamped to now+15 min, offer expires in ~15 min", () => {
    const scheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h ahead → rawCutoff is in the past
    const now = new Date();
    const policy = AcceptancePolicyEngine.computePolicy(scheduledAt, true);
    expect(policy.isScheduled).toBe(true);
    expect(policy.operationalCutoffAt).not.toBeNull();
    const expiry = AcceptancePolicyEngine.computeOfferExpiry(now, policy);
    const windowMs = expiry.getTime() - now.getTime();
    expect(windowMs).toBeGreaterThanOrEqual(15 * 60 * 1000 - 5_000);
    expect(windowMs).toBeLessThanOrEqual(15 * 60 * 1000 + 5_000);
  });
});

// --- Integration tests: MatchRideUseCase wires isNetworkOwned ---
// All rides use scheduledAt = now+48h: operationalCutoff passes, window = 30 min.
// The 15-min SLA for immediate rides is validated in unit tests 1-2 above.

describe("MatchRideUseCase - network SLA integration (scheduled rides)", () => {
  let networkDriver: { id: string };

  // Use beforeEach (not beforeAll) because tests/setup.ts runs
  // cleanTestData() in beforeEach, which would otherwise wipe a beforeAll-created driver.
  beforeEach(async () => {
    networkDriver = await makeDriver("sla-root");
  });

  afterAll(async () => {
    await cleanTestData();
  });

  test("5. D2P passenger (rootDriverId set): offer created with 30-min expiresAt", async () => {
    const passenger = await makePassenger("d2p-sla", networkDriver.id);
    const ride = await makeRide(passenger.id, null);
    const before = Date.now();
    const uc = new MatchRideUseCase();
    await uc.execute({ rideId: ride.id, candidateDriverIds: [networkDriver.id] });
    const offer = await prisma.rideOffer.findFirst({ where: { rideRequestId: ride.id } });
    expect(offer).not.toBeNull();
    const windowMs = offer!.expiresAt.getTime() - before;
    expect(windowMs).toBeGreaterThanOrEqual(SCHEDULED_OFFER_TIMEOUT_MS - 5_000);
    expect(windowMs).toBeLessThanOrEqual(SCHEDULED_OFFER_TIMEOUT_MS + 5_000);
  });

  test("6. Public passenger (no rootDriverId): offer with 30-min expiresAt (no regression)", async () => {
    const passenger = await makePassenger("public-sla", null);
    const ride = await makeRide(passenger.id, null);
    const before = Date.now();
    const uc = new MatchRideUseCase();
    await uc.execute({ rideId: ride.id, candidateDriverIds: [networkDriver.id] });
    const offer = await prisma.rideOffer.findFirst({ where: { rideRequestId: ride.id } });
    expect(offer).not.toBeNull();
    const windowMs = offer!.expiresAt.getTime() - before;
    expect(windowMs).toBeGreaterThanOrEqual(SCHEDULED_OFFER_TIMEOUT_MS - 5_000);
    expect(windowMs).toBeLessThanOrEqual(SCHEDULED_OFFER_TIMEOUT_MS + 5_000);
  });

  test("7. P2P passenger inheriting rootDriverId: offer created, network context preserved", async () => {
    const p2pPassenger = await makePassenger("p2p-sla", networkDriver.id);
    const ride = await makeRide(p2pPassenger.id, networkDriver.id);
    const uc = new MatchRideUseCase();
    const result = await uc.execute({ rideId: ride.id, candidateDriverIds: [networkDriver.id] });
    expect(result.matched).toBe(true);
    const offer = await prisma.rideOffer.findFirst({ where: { rideRequestId: ride.id } });
    expect(offer).not.toBeNull();
    expect(offer!.status).toBe("PENDING");
  });

  test("8. Public ride via GENERAL level: 30-min window (no regression)", async () => {
    const passenger = await makePassenger("no-root-sla", null);
    const ride = await makeRide(passenger.id, null);
    const before = Date.now();
    const uc = new MatchRideUseCase();
    await uc.execute({ rideId: ride.id, level: "GENERAL", candidateDriverIds: [networkDriver.id] });
    const offer = await prisma.rideOffer.findFirst({ where: { rideRequestId: ride.id } });
    expect(offer).not.toBeNull();
    const windowMs = offer!.expiresAt.getTime() - before;
    expect(windowMs).toBeGreaterThanOrEqual(SCHEDULED_OFFER_TIMEOUT_MS - 5_000);
    expect(windowMs).toBeLessThanOrEqual(SCHEDULED_OFFER_TIMEOUT_MS + 5_000);
  });
});
