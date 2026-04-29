import request from "supertest";
import { app } from "../src/server";
import { prisma } from "./setup";
import {
  createDriverReferralChain,
  getDriverNetwork,
} from "../src/application/use-cases/DriverReferralService";

jest.setTimeout(15000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createDriver(
  name: string,
  email: string,
  phone: string,
  referredByDriverId?: string
) {
  return prisma.user.create({
    data: {
      name,
      email,
      phone,
      role: "DRIVER",
      driver: {
        create: {
          experienceLevel: "INTERMEDIARIO",
          isActive: true,
          ...(referredByDriverId ? { referredByDriverId } : {}),
        },
      },
    },
    include: { driver: true },
  });
}

async function waitForOffers(
  rideId: string,
  minCount = 1,
  maxWaitMs = 5000,
  intervalMs = 150
): Promise<Array<{ id: string; driverId: string; createdAt: Date }>> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const offers = await prisma.rideOffer.findMany({
      where: { rideRequestId: rideId },
      orderBy: { createdAt: "asc" },
      select: { id: true, driverId: true, createdAt: true },
    });
    if (offers.length >= minCount) return offers;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return [];
}

// ─── createDriverReferralChain ────────────────────────────────────────────────

describe("createDriverReferralChain", () => {
  it("deve criar uma entrada de nível 1 quando driver B é indicado por A", async () => {
    const driverAUser = await createDriver(
      "Driver A",
      "a@referral.com",
      "10000000001"
    );
    const driverBUser = await createDriver(
      "Driver B",
      "b@referral.com",
      "10000000002",
      driverAUser.driver!.id
    );

    await createDriverReferralChain(
      driverBUser.driver!.id,
      driverAUser.driver!.id
    );

    const entries = await prisma.driverReferral.findMany({
      where: { referrerDriverId: driverAUser.driver!.id },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].referredDriverId).toBe(driverBUser.driver!.id);
    expect(entries[0].level).toBe(1);
  });

  it("deve criar entradas de nível 1 e 2 quando a cadeia tem 3 drivers (A→B→C)", async () => {
    const driverAUser = await createDriver(
      "Driver A",
      "a@chain.com",
      "20000000001"
    );
    const driverBUser = await createDriver(
      "Driver B",
      "b@chain.com",
      "20000000002",
      driverAUser.driver!.id
    );
    // Build A→B chain
    await createDriverReferralChain(
      driverBUser.driver!.id,
      driverAUser.driver!.id
    );

    const driverCUser = await createDriver(
      "Driver C",
      "c@chain.com",
      "20000000003",
      driverBUser.driver!.id
    );
    // Build B→C chain (also propagates A→C at level 2)
    await createDriverReferralChain(
      driverCUser.driver!.id,
      driverBUser.driver!.id
    );

    // Level 1: B referred C
    const bEntries = await prisma.driverReferral.findMany({
      where: {
        referrerDriverId: driverBUser.driver!.id,
        referredDriverId: driverCUser.driver!.id,
      },
    });
    expect(bEntries).toHaveLength(1);
    expect(bEntries[0].level).toBe(1);

    // Level 2: A is ancestor of C at distance 2
    const aEntries = await prisma.driverReferral.findMany({
      where: {
        referrerDriverId: driverAUser.driver!.id,
        referredDriverId: driverCUser.driver!.id,
      },
    });
    expect(aEntries).toHaveLength(1);
    expect(aEntries[0].level).toBe(2);
  });

  it("não deve criar entradas além do nível 3", async () => {
    const a = await createDriver("A4", "a4@chain.com", "30000000001");
    const b = await createDriver("B4", "b4@chain.com", "30000000002", a.driver!.id);
    await createDriverReferralChain(b.driver!.id, a.driver!.id);

    const c = await createDriver("C4", "c4@chain.com", "30000000003", b.driver!.id);
    await createDriverReferralChain(c.driver!.id, b.driver!.id);

    const d = await createDriver("D4", "d4@chain.com", "30000000004", c.driver!.id);
    await createDriverReferralChain(d.driver!.id, c.driver!.id);

    // A→D would be level 3 (A→B level 1, B→C level 2 from A, C→D level 3 from A)
    const aToD = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: a.driver!.id,
        referredDriverId: d.driver!.id,
      },
    });
    expect(aToD).toBeTruthy();
    expect(aToD!.level).toBe(3);

    // Now create E — A→E would be level 4 → must NOT be created
    const e = await createDriver("E4", "e4@chain.com", "30000000005", d.driver!.id);
    await createDriverReferralChain(e.driver!.id, d.driver!.id);

    const aToE = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: a.driver!.id,
        referredDriverId: e.driver!.id,
      },
    });
    expect(aToE).toBeNull();
  });
});

// ─── getDriverNetwork ─────────────────────────────────────────────────────────

describe("getDriverNetwork", () => {
  it("deve retornar a rede agrupada por nível", async () => {
    const a = await createDriver("Net A", "neta@net.com", "40000000001");
    const b = await createDriver(
      "Net B",
      "netb@net.com",
      "40000000002",
      a.driver!.id
    );
    await createDriverReferralChain(b.driver!.id, a.driver!.id);

    const c = await createDriver(
      "Net C",
      "netc@net.com",
      "40000000003",
      b.driver!.id
    );
    await createDriverReferralChain(c.driver!.id, b.driver!.id);

    const network = await getDriverNetwork(a.driver!.id);

    expect(network.level1).toContain(b.driver!.id);
    expect(network.level2).toContain(c.driver!.id);
    expect(network.level3).toHaveLength(0);
  });

  it("deve retornar rede vazia para driver sem indicações", async () => {
    const a = await createDriver("Solo", "solo@net.com", "50000000001");
    const network = await getDriverNetwork(a.driver!.id);

    expect(network.level1).toHaveLength(0);
    expect(network.level2).toHaveLength(0);
    expect(network.level3).toHaveLength(0);
  });
});

// ─── Matching com rede de 3 níveis ───────────────────────────────────────────

describe("Matching — rede de indicação 3 níveis", () => {
  it("deve incluir drivers de nível 2 na tier PARTNER após rejeição do nível 1", async () => {
    // A → B (nível 1 de A)
    // B → C (nível 1 de B, nível 2 de A)
    const driverAUser = await createDriver(
      "Net Driver A",
      "neta@match3.com",
      "60000000001"
    );
    const driverBUser = await createDriver(
      "Net Driver B",
      "netb@match3.com",
      "60000000002",
      driverAUser.driver!.id
    );
    await createDriverReferralChain(
      driverBUser.driver!.id,
      driverAUser.driver!.id
    );

    const driverCUser = await createDriver(
      "Net Driver C",
      "netc@match3.com",
      "60000000003",
      driverBUser.driver!.id
    );
    await createDriverReferralChain(
      driverCUser.driver!.id,
      driverBUser.driver!.id
    );

    // Passenger referred by A
    const passengerUser = await prisma.user.create({
      data: {
        name: "Passageiro Net",
        email: "pass@match3.com",
        phone: "60000000004",
        role: "PASSENGER",
      },
    });
    const passenger = await prisma.passenger.create({
      data: {
        userId: passengerUser.id,
        referredByDriverId: driverAUser.driver!.id,
      },
    });

    // Create ride → REFERRED tier → offer to A
    const rideResponse = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Zona Norte",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

    expect(rideResponse.status).toBe(201);

    const offersAfterCreate = await waitForOffers(rideResponse.body.ride.id, 1);
    expect(offersAfterCreate.length).toBeGreaterThan(0);

    const driverAOffer = offersAfterCreate.find(
      (o) => o.driverId === driverAUser.driver!.id
    );
    expect(driverAOffer).toBeTruthy();

    // A rejects → re-match → PARTNER tier (B and C from DriverReferral)
    const rejectResponse = await request(app)
      .patch(`/offers/${driverAOffer!.id}/respond`)
      .send({ accept: false });

    expect(rejectResponse.status).toBe(200);

    // B (level 1 in A's network) must receive an offer
    const driverBOffer = await prisma.rideOffer.findFirst({
      where: {
        rideRequestId: rideResponse.body.ride.id,
        driverId: driverBUser.driver!.id,
      },
    });
    expect(driverBOffer).toBeTruthy();

    // C (level 2 in A's network) must also receive an offer
    const driverCOffer = await prisma.rideOffer.findFirst({
      where: {
        rideRequestId: rideResponse.body.ride.id,
        driverId: driverCUser.driver!.id,
      },
    });
    expect(driverCOffer).toBeTruthy();
  });
});
