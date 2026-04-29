import request from "supertest";
import { app } from "../src/server";
import { prisma } from "./setup";

jest.setTimeout(15000);

// ─── Helper: wait for offers ─────────────────────────────────────────────────
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

// ─── Helper: create driver via API ───────────────────────────────────────────
async function createDriver(data: {
  name: string;
  email: string;
  phone: string;
  experienceLevel?: string;
  referredByDriverId?: string;
}) {
  const response = await request(app)
    .post("/drivers")
    .send({
      experienceLevel: "PROFISSIONAL",
      ...data,
    });
  expect(response.status).toBe(201);
  return response.body.driver as { id: string };
}

// ─── 1. Driver creation via API ───────────────────────────────────────────────
describe("Driver — criação via API", () => {
  it("deve criar um driver sem referral", async () => {
    const response = await request(app).post("/drivers").send({
      name: "Driver Solo",
      email: "solo@driver.com",
      phone: "10000000001",
      experienceLevel: "INICIANTE",
    });

    expect(response.status).toBe(201);
    expect(response.body.driver).toBeTruthy();
    expect(response.body.driver.id).toBeTruthy();
  });

  it("deve criar um driver com referredByDriverId", async () => {
    const referrer = await createDriver({
      name: "Referrer Driver",
      email: "referrer@driver.com",
      phone: "10000000002",
    });

    const response = await request(app).post("/drivers").send({
      name: "Referred Driver",
      email: "referred@driver.com",
      phone: "10000000003",
      experienceLevel: "INTERMEDIARIO",
      referredByDriverId: referrer.id,
    });

    expect(response.status).toBe(201);
    expect(response.body.driver.referredByDriverId).toBe(referrer.id);

    // DriverReferral record should be created
    const referral = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: referrer.id,
        referredDriverId: response.body.driver.id,
      },
    });
    expect(referral).toBeTruthy();
    expect(referral!.level).toBe(1);
  });

  it("deve retornar 404 ao indicar driver inexistente", async () => {
    const response = await request(app).post("/drivers").send({
      name: "Bad Referral Driver",
      email: "bad@driver.com",
      phone: "10000000004",
      experienceLevel: "INICIANTE",
      referredByDriverId: "non-existent-id",
    });

    expect(response.status).toBe(404);
  });

  it("deve retornar 400 se campos obrigatórios estiverem ausentes", async () => {
    const response = await request(app).post("/drivers").send({
      name: "Incomplete Driver",
    });

    expect(response.status).toBe(400);
  });
});

// ─── 2. Referral chain creation ───────────────────────────────────────────────
describe("DriverReferral — cadeia de indicação", () => {
  it("deve criar cadeia de nível 1 ao indicar um driver diretamente", async () => {
    const driverA = await createDriver({
      name: "Driver A",
      email: "a@chain.com",
      phone: "20000000001",
    });

    const driverB = await createDriver({
      name: "Driver B",
      email: "b@chain.com",
      phone: "20000000002",
      referredByDriverId: driverA.id,
    });

    const referrals = await prisma.driverReferral.findMany({
      where: { referrerDriverId: driverA.id },
    });

    expect(referrals.length).toBe(1);
    expect(referrals[0].referredDriverId).toBe(driverB.id);
    expect(referrals[0].level).toBe(1);
  });

  it("deve criar cadeia de nível 2 quando C é indicado por B (que foi indicado por A)", async () => {
    const driverA = await createDriver({
      name: "Driver A",
      email: "a@level2.com",
      phone: "21000000001",
    });

    const driverB = await createDriver({
      name: "Driver B",
      email: "b@level2.com",
      phone: "21000000002",
      referredByDriverId: driverA.id,
    });

    const driverC = await createDriver({
      name: "Driver C",
      email: "c@level2.com",
      phone: "21000000003",
      referredByDriverId: driverB.id,
    });

    // A → C should be level 2
    const level2Referral = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: driverA.id,
        referredDriverId: driverC.id,
      },
    });

    expect(level2Referral).toBeTruthy();
    expect(level2Referral!.level).toBe(2);

    // B → C should be level 1
    const level1Referral = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: driverB.id,
        referredDriverId: driverC.id,
      },
    });

    expect(level1Referral).toBeTruthy();
    expect(level1Referral!.level).toBe(1);
  });

  it("deve criar cadeia de nível 3 para D indicado por C (A → B → C → D)", async () => {
    const driverA = await createDriver({
      name: "Driver A",
      email: "a@level3.com",
      phone: "22000000001",
    });

    const driverB = await createDriver({
      name: "Driver B",
      email: "b@level3.com",
      phone: "22000000002",
      referredByDriverId: driverA.id,
    });

    const driverC = await createDriver({
      name: "Driver C",
      email: "c@level3.com",
      phone: "22000000003",
      referredByDriverId: driverB.id,
    });

    const driverD = await createDriver({
      name: "Driver D",
      email: "d@level3.com",
      phone: "22000000004",
      referredByDriverId: driverC.id,
    });

    // A → D should be level 3
    const level3Referral = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: driverA.id,
        referredDriverId: driverD.id,
      },
    });

    expect(level3Referral).toBeTruthy();
    expect(level3Referral!.level).toBe(3);

    // B → D should be level 2
    const level2Referral = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: driverB.id,
        referredDriverId: driverD.id,
      },
    });

    expect(level2Referral).toBeTruthy();
    expect(level2Referral!.level).toBe(2);

    // C → D should be level 1
    const level1Referral = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: driverC.id,
        referredDriverId: driverD.id,
      },
    });

    expect(level1Referral).toBeTruthy();
    expect(level1Referral!.level).toBe(1);
  });

  it("não deve criar nível 4 ou superior (limite de 3 níveis)", async () => {
    const driverA = await createDriver({
      name: "Driver A",
      email: "a@maxlevel.com",
      phone: "23000000001",
    });
    const driverB = await createDriver({
      name: "Driver B",
      email: "b@maxlevel.com",
      phone: "23000000002",
      referredByDriverId: driverA.id,
    });
    const driverC = await createDriver({
      name: "Driver C",
      email: "c@maxlevel.com",
      phone: "23000000003",
      referredByDriverId: driverB.id,
    });
    const driverD = await createDriver({
      name: "Driver D",
      email: "d@maxlevel.com",
      phone: "23000000004",
      referredByDriverId: driverC.id,
    });

    // Create E (5th in chain) — A should NOT be referrer of E (would be level 4)
    const driverE = await createDriver({
      name: "Driver E",
      email: "e@maxlevel.com",
      phone: "23000000005",
      referredByDriverId: driverD.id,
    });

    const wouldBeLevel4 = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: driverA.id,
        referredDriverId: driverE.id,
      },
    });

    expect(wouldBeLevel4).toBeNull();

    // D → E should be level 1
    const directReferral = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: driverD.id,
        referredDriverId: driverE.id,
      },
    });
    expect(directReferral).toBeTruthy();
    expect(directReferral!.level).toBe(1);
  });
});

// ─── 3. getDriverNetwork endpoint ────────────────────────────────────────────
describe("GET /drivers/:id/network", () => {
  it("deve retornar a rede de indicações de um driver", async () => {
    const driverA = await createDriver({
      name: "Driver A",
      email: "a@network.com",
      phone: "24000000001",
    });

    await createDriver({
      name: "Driver B",
      email: "b@network.com",
      phone: "24000000002",
      referredByDriverId: driverA.id,
    });

    await createDriver({
      name: "Driver C",
      email: "c@network.com",
      phone: "24000000003",
      referredByDriverId: driverA.id,
    });

    const response = await request(app).get(`/drivers/${driverA.id}/network`);

    expect(response.status).toBe(200);
    expect(response.body.network).toHaveLength(2);
    expect(response.body.network.every((r: { level: number }) => r.level === 1)).toBe(true);
  });

  it("deve retornar 404 para driver inexistente", async () => {
    const response = await request(app).get("/drivers/non-existent-id/network");
    expect(response.status).toBe(404);
  });

  it("deve incluir drivers de todos os níveis na rede", async () => {
    const driverA = await createDriver({
      name: "Driver A",
      email: "a@fullnet.com",
      phone: "25000000001",
    });

    const driverB = await createDriver({
      name: "Driver B",
      email: "b@fullnet.com",
      phone: "25000000002",
      referredByDriverId: driverA.id,
    });

    await createDriver({
      name: "Driver C",
      email: "c@fullnet.com",
      phone: "25000000003",
      referredByDriverId: driverB.id,
    });

    const response = await request(app).get(`/drivers/${driverA.id}/network`);

    expect(response.status).toBe(200);
    // A's network: B (level 1) + C (level 2) = 2 entries
    expect(response.body.network).toHaveLength(2);

    const levels = response.body.network.map((r: { level: number }) => r.level).sort();
    expect(levels).toEqual([1, 2]);
  });
});

// ─── 4. Matching with DriverReferral multi-level network ─────────────────────
describe("Matching — PARTNER com rede DriverReferral multi-nível", () => {
  it("deve incluir driver de nível 2 no PARTNER tier após rejeição do driver indicado", async () => {
    // Driver A — refers passenger and is directly referred by nobody
    const driverA = await createDriver({
      name: "Driver A",
      email: "a@multilevel.com",
      phone: "26000000001",
    });

    // Driver B — referred by A (level 1)
    const driverB = await createDriver({
      name: "Driver B",
      email: "b@multilevel.com",
      phone: "26000000002",
      referredByDriverId: driverA.id,
    });

    // Driver C — referred by B (level 1 from B, level 2 from A)
    await createDriver({
      name: "Driver C",
      email: "c@multilevel.com",
      phone: "26000000003",
      referredByDriverId: driverB.id,
    });

    // Passenger referred by A
    const passengerUser = await prisma.user.create({
      data: {
        name: "Passageiro Multi",
        email: "passageiro@multilevel.com",
        phone: "26000000004",
        role: "PASSENGER",
      },
    });
    const passenger = await prisma.passenger.create({
      data: {
        userId: passengerUser.id,
        referredByDriverId: driverA.id,
      },
    });

    // Create ride → Driver A gets REFERRED offer
    const rideResponse = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Ipanema",
        destination: "Tijuca",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

    expect(rideResponse.status).toBe(201);
    const rideId = rideResponse.body.ride.id;

    // Wait for Driver A's REFERRED offer
    const offersAfterCreate = await waitForOffers(rideId, 1);
    const driverAOffer = offersAfterCreate.find((o) => o.driverId === driverA.id);
    expect(driverAOffer).toBeTruthy();

    // Driver A rejects → triggers PARTNER tier re-match
    const rejectResponse = await request(app)
      .patch(`/offers/${driverAOffer!.id}/respond`)
      .send({ accept: false });

    expect(rejectResponse.status).toBe(200);

    // B and C should both receive offers (level 1 and level 2 in A's network)
    const allOffers = await prisma.rideOffer.findMany({
      where: { rideRequestId: rideId },
      select: { driverId: true },
    });

    const offerDriverIds = allOffers.map((o) => o.driverId);
    expect(offerDriverIds).toContain(driverB.id);
  });
});
