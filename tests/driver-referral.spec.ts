import request from "supertest";
import { app } from "../src/server";
import { prisma } from "./setup";
import {
  createDriverReferralChain,
  getDriverNetwork,
} from "../src/application/use-cases/DriverReferralService";

jest.setTimeout(15000);

// ─── Helper: create a bare driver directly in DB ──────────────────────────
async function createDriver(
  name: string,
  email: string,
  phone: string
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      role: "DRIVER",
      driver: {
        create: { experienceLevel: "INTERMEDIARIO", isActive: true },
      },
    },
    include: { driver: true },
  });
  return user.driver!.id;
}

// ─── Criação da cadeia de indicação ───────────────────────────────────────
describe("DriverReferral — createDriverReferralChain", () => {
  it("deve criar registro de nível 1 quando driver é indicado diretamente", async () => {
    const driverAId = await createDriver("Driver A", "a@ref.com", "10000000001");
    const driverBId = await createDriver("Driver B", "b@ref.com", "10000000002");

    await createDriverReferralChain(driverBId, driverAId);

    const referral = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverAId, referredDriverId: driverBId },
    });

    expect(referral).toBeTruthy();
    expect(referral!.level).toBe(1);
  });

  it("deve criar registros de nível 1 e 2 em uma cadeia A→B→C", async () => {
    const driverAId = await createDriver("Driver A", "a2@ref.com", "10000000011");
    const driverBId = await createDriver("Driver B", "b2@ref.com", "10000000012");
    const driverCId = await createDriver("Driver C", "c2@ref.com", "10000000013");

    // A recruits B
    await createDriverReferralChain(driverBId, driverAId);
    // B recruits C → creates B→C (level 1) and A→C (level 2)
    await createDriverReferralChain(driverCId, driverBId);

    const bcReferral = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverBId, referredDriverId: driverCId },
    });
    expect(bcReferral).toBeTruthy();
    expect(bcReferral!.level).toBe(1);

    const acReferral = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverAId, referredDriverId: driverCId },
    });
    expect(acReferral).toBeTruthy();
    expect(acReferral!.level).toBe(2);
  });

  it("deve criar registros de nível 1, 2 e 3 em uma cadeia A→B→C→D", async () => {
    const driverAId = await createDriver("Driver A", "a3@ref.com", "10000000021");
    const driverBId = await createDriver("Driver B", "b3@ref.com", "10000000022");
    const driverCId = await createDriver("Driver C", "c3@ref.com", "10000000023");
    const driverDId = await createDriver("Driver D", "d3@ref.com", "10000000024");

    await createDriverReferralChain(driverBId, driverAId); // A→B level 1
    await createDriverReferralChain(driverCId, driverBId); // B→C level 1, A→C level 2
    await createDriverReferralChain(driverDId, driverCId); // C→D level 1, B→D level 2, A→D level 3

    const adReferral = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverAId, referredDriverId: driverDId },
    });
    expect(adReferral).toBeTruthy();
    expect(adReferral!.level).toBe(3);
  });

  it("não deve criar registros além do nível 3", async () => {
    const driverAId = await createDriver("Driver A", "a4@ref.com", "10000000031");
    const driverBId = await createDriver("Driver B", "b4@ref.com", "10000000032");
    const driverCId = await createDriver("Driver C", "c4@ref.com", "10000000033");
    const driverDId = await createDriver("Driver D", "d4@ref.com", "10000000034");
    const driverEId = await createDriver("Driver E", "e4@ref.com", "10000000035");

    await createDriverReferralChain(driverBId, driverAId);
    await createDriverReferralChain(driverCId, driverBId);
    await createDriverReferralChain(driverDId, driverCId);
    // E is recruited by D → A→E would be level 4, which should NOT be created
    await createDriverReferralChain(driverEId, driverDId);

    const aeReferral = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverAId, referredDriverId: driverEId },
    });
    expect(aeReferral).toBeNull();
  });

  it("deve ser idempotente (upsert não cria duplicatas)", async () => {
    const driverAId = await createDriver("Driver A", "a5@ref.com", "10000000041");
    const driverBId = await createDriver("Driver B", "b5@ref.com", "10000000042");

    await createDriverReferralChain(driverBId, driverAId);
    await createDriverReferralChain(driverBId, driverAId); // second call should not throw

    const count = await prisma.driverReferral.count({
      where: { referrerDriverId: driverAId, referredDriverId: driverBId },
    });
    expect(count).toBe(1);
  });
});

// ─── getDriverNetwork ─────────────────────────────────────────────────────
describe("DriverReferral — getDriverNetwork", () => {
  it("deve retornar a rede de indicação agrupada por nível", async () => {
    const driverAId = await createDriver("Driver A", "a6@ref.com", "10000000051");
    const driverBId = await createDriver("Driver B", "b6@ref.com", "10000000052");
    const driverCId = await createDriver("Driver C", "c6@ref.com", "10000000053");
    const driverDId = await createDriver("Driver D", "d6@ref.com", "10000000054");

    await createDriverReferralChain(driverBId, driverAId);
    await createDriverReferralChain(driverCId, driverBId);
    await createDriverReferralChain(driverDId, driverCId);

    const network = await getDriverNetwork(driverAId);

    expect(network.level1).toContain(driverBId);
    expect(network.level2).toContain(driverCId);
    expect(network.level3).toContain(driverDId);
  });

  it("deve retornar rede vazia para driver sem indicações", async () => {
    const driverAId = await createDriver("Driver A", "a7@ref.com", "10000000061");

    const network = await getDriverNetwork(driverAId);

    expect(network.level1).toHaveLength(0);
    expect(network.level2).toHaveLength(0);
    expect(network.level3).toHaveLength(0);
  });
});

// ─── Rota POST /drivers ───────────────────────────────────────────────────
describe("POST /drivers", () => {
  it("deve criar um driver sem indicação", async () => {
    const response = await request(app).post("/drivers").send({
      name: "Novo Driver",
      email: "novo@driver.com",
      phone: "20000000001",
      experienceLevel: "INICIANTE",
    });

    expect(response.status).toBe(201);
    expect(response.body.driver).toBeTruthy();
    expect(response.body.driver.referredByDriverId).toBeNull();
  });

  it("deve criar um driver com indicação e gerar cadeia de referral", async () => {
    const referrerResponse = await request(app).post("/drivers").send({
      name: "Referrer",
      email: "referrer@driver.com",
      phone: "20000000010",
      experienceLevel: "PROFISSIONAL",
    });
    expect(referrerResponse.status).toBe(201);
    const referrerId = referrerResponse.body.driver.id;

    const newDriverResponse = await request(app).post("/drivers").send({
      name: "Referred Driver",
      email: "referred@driver.com",
      phone: "20000000011",
      experienceLevel: "INICIANTE",
      referredByDriverId: referrerId,
    });

    expect(newDriverResponse.status).toBe(201);
    expect(newDriverResponse.body.driver.referredByDriverId).toBe(referrerId);

    const referral = await prisma.driverReferral.findFirst({
      where: {
        referrerDriverId: referrerId,
        referredDriverId: newDriverResponse.body.driver.id,
      },
    });
    expect(referral).toBeTruthy();
    expect(referral!.level).toBe(1);
  });

  it("deve retornar 404 se referredByDriverId não existe", async () => {
    const response = await request(app).post("/drivers").send({
      name: "Driver Test",
      email: "test404@driver.com",
      phone: "20000000020",
      experienceLevel: "INICIANTE",
      referredByDriverId: "non-existent-id",
    });

    expect(response.status).toBe(404);
  });
});

// ─── Rota GET /drivers/:id/network ────────────────────────────────────────
describe("GET /drivers/:id/network", () => {
  it("deve retornar a rede de indicação via rota HTTP", async () => {
    const driverAId = await createDriver("Driver A", "netA@ref.com", "30000000001");
    const driverBId = await createDriver("Driver B", "netB@ref.com", "30000000002");

    await createDriverReferralChain(driverBId, driverAId);

    const response = await request(app).get(`/drivers/${driverAId}/network`);

    expect(response.status).toBe(200);
    expect(response.body.network.level1).toContain(driverBId);
  });

  it("deve retornar 404 para driver inexistente", async () => {
    const response = await request(app).get("/drivers/non-existent-id/network");
    expect(response.status).toBe(404);
  });
});

// ─── Matching com rede de indicação (integração) ──────────────────────────
describe("Matching — rede de indicação multi-nível", () => {
  it("deve enviar offer para driver de nível 2 após rejeição dos níveis anteriores", async () => {
    // Driver A — indicador do passageiro
    const driverAUser = await prisma.user.create({
      data: {
        name: "Driver A",
        email: "a@multilevel.com",
        phone: "40000000001",
        role: "DRIVER",
        driver: { create: { experienceLevel: "PROFISSIONAL", isActive: true } },
      },
      include: { driver: true },
    });

    // Driver B — nível 1 da rede de A (A indicou B)
    const driverBUser = await prisma.user.create({
      data: {
        name: "Driver B",
        email: "b@multilevel.com",
        phone: "40000000002",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "INTERMEDIARIO",
            isActive: true,
            referredByDriverId: driverAUser.driver!.id,
          },
        },
      },
      include: { driver: true },
    });
    await createDriverReferralChain(driverBUser.driver!.id, driverAUser.driver!.id);

    // Driver C — nível 2 da rede de A (B indicou C)
    const driverCUser = await prisma.user.create({
      data: {
        name: "Driver C",
        email: "c@multilevel.com",
        phone: "40000000003",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "INICIANTE",
            isActive: true,
            referredByDriverId: driverBUser.driver!.id,
          },
        },
      },
      include: { driver: true },
    });
    await createDriverReferralChain(driverCUser.driver!.id, driverBUser.driver!.id);

    // Passageiro indicado por Driver A
    const passengerUser = await prisma.user.create({
      data: {
        name: "Passageiro",
        email: "passageiro@multilevel.com",
        phone: "40000000004",
        role: "PASSENGER",
      },
    });
    const passenger = await prisma.passenger.create({
      data: {
        userId: passengerUser.id,
        referredByDriverId: driverAUser.driver!.id,
      },
    });

    // Criar corrida → Tier 1 (REFERRED) → A recebe offer
    const rideResponse = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Ipanema",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

    expect(rideResponse.status).toBe(201);
    const rideId = rideResponse.body.ride.id;

    // Aguardar offer de Driver A
    const deadline = Date.now() + 5000;
    let offers: Array<{ id: string; driverId: string }> = [];
    while (Date.now() < deadline) {
      offers = await prisma.rideOffer.findMany({
        where: { rideRequestId: rideId },
        select: { id: true, driverId: true },
      });
      if (offers.length >= 1) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const driverAOffer = offers.find((o) => o.driverId === driverAUser.driver!.id);
    expect(driverAOffer).toBeTruthy();

    // Driver A rejeita → Tier 2 (PARTNER) → B recebe offer
    await request(app)
      .patch(`/offers/${driverAOffer!.id}/respond`)
      .send({ accept: false });

    const driverBOffer = await prisma.rideOffer.findFirst({
      where: { rideRequestId: rideId, driverId: driverBUser.driver!.id },
    });
    expect(driverBOffer).toBeTruthy();

    // Driver B rejeita → Tier 2 continua (C está na rede de A via nível 2)
    await request(app)
      .patch(`/offers/${driverBOffer!.id}/respond`)
      .send({ accept: false });

    const driverCOffer = await prisma.rideOffer.findFirst({
      where: { rideRequestId: rideId, driverId: driverCUser.driver!.id },
    });
    expect(driverCOffer).toBeTruthy();
  });
});
