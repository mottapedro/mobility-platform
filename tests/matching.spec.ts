/// <reference types="jest" />
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";
import { createDriverReferralChain } from "../src/domain/services/DriverReferralService";

jest.setTimeout(15000);

// ─── Aguarda até offers aparecerem no banco ────────────────────────────────
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

// ─── Tier 1 — REFERRED ────────────────────────────────────────────────────
describe("Matching — Tier 1 (REFERRED)", () => {
  it("deve enviar a primeira offer para o driver que indicou o passageiro", async () => {
    // Driver A — o indicador
    const driverAUser = await prisma.user.create({
      data: {
        name: "Driver A",
        email: "drivera@matching.com",
        phone: "11000000001",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "PROFISSIONAL",
            isActive: true,
          },
        },
      },
      include: { driver: true },
    });

    // Driver Geral — não deve receber a primeira offer
    await prisma.user.create({
      data: {
        name: "Driver Geral",
        email: "geral@matching.com",
        phone: "11000000002",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "INICIANTE",
            isActive: true,
          },
        },
      },
    });

    // Passageiro indicado por Driver A
    const passengerUser = await prisma.user.create({
      data: {
        name: "Passageiro Indicado",
        email: "passageiro.ref@matching.com",
        phone: "11000000003",
        role: "PASSENGER",
      },
    });
    const passenger = await prisma.passenger.create({
      data: {
        userId: passengerUser.id,
        referralCode: "ref-t1-" + Date.now(),
        publicSlug:   "slug-t1-" + Date.now(),
        referredByDriverId: driverAUser.driver!.id,
      },
    });

    const response = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Barra da Tijuca",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 90_000_000).toISOString(),
        originLat: -22.9068, originLng: -43.1729,
        destinationLat: -22.8833, destinationLng: -43.1072,
      });

    expect(response.status).toBe(201);

    // No Tier REFERRED apenas 1 offer é criada (para o driver indicado)
    const offers = await waitForOffers(response.body.ride.id, 1);

    expect(offers.length).toBeGreaterThan(0);
    // A primeira (e única) offer deve ser para Driver A
    expect(offers[0].driverId).toBe(driverAUser.driver!.id);
  });
});

// ─── Tier 2 — PARTNER ─────────────────────────────────────────────────────
describe("Matching — Tier 2 (PARTNER)", () => {
  it("deve enviar offer para parceiro de Driver A após rejeição de Driver A", async () => {
    // Driver A — o indicador
    const driverAUser = await prisma.user.create({
      data: {
        name: "Driver A",
        email: "drivera@partner.com",
        phone: "22000000001",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "PROFISSIONAL",
            isActive: true,
          },
        },
      },
      include: { driver: true },
    });

    // Driver B — parceiro de A (level 1 na rede)
    const driverBUser = await prisma.user.create({
      data: {
        name: "Driver B",
        email: "driverb@partner.com",
        phone: "22000000002",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "INTERMEDIARIO",
            isActive: true,
          },
        },
      },
      include: { driver: true },
    });
    await createDriverReferralChain(driverBUser.driver!.id, driverAUser.driver!.id);

    // Passageiro indicado por Driver A
    const passengerUser = await prisma.user.create({
      data: {
        name: "Passageiro",
        email: "passageiro@partner.com",
        phone: "22000000003",
        role: "PASSENGER",
      },
    });
    const passenger = await prisma.passenger.create({
      data: {
        userId: passengerUser.id,
        referralCode: "ref-t2-" + Date.now(),
        publicSlug:   "slug-t2-" + Date.now(),
        referredByDriverId: driverAUser.driver!.id,
      },
    });

    // Criar corrida → matching → Driver A recebe offer (REFERRED)
    const rideResponse = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Barra da Tijuca",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 90_000_000).toISOString(),
        originLat: -22.9068, originLng: -43.1729,
        destinationLat: -22.8833, destinationLng: -43.1072,
      });

    expect(rideResponse.status).toBe(201);

    // Aguardar offer de Driver A
    const offersAfterCreate = await waitForOffers(rideResponse.body.ride.id, 1);
    expect(offersAfterCreate.length).toBeGreaterThan(0);

    const driverAOffer = offersAfterCreate.find(
      (o) => o.driverId === driverAUser.driver!.id
    );
    expect(driverAOffer).toBeTruthy();

    // Driver A rejeita → dispara re-match síncrono → Tier 2 (PARTNER)
    const rejectResponse = await request(app)
      .patch(`/offers/${driverAOffer!.id}/respond`)
      .send({ accept: false });

    expect(rejectResponse.status).toBe(200);

    // Após reject, o re-match é awaited internamente — offer de Driver B já deve existir
    const driverBOffer = await prisma.rideOffer.findFirst({
      where: {
        rideRequestId: rideResponse.body.ride.id,
        driverId: driverBUser.driver!.id,
      },
    });

    expect(driverBOffer).toBeTruthy();
  });
});

// ─── Contexto VIP ─────────────────────────────────────────────────────────
describe("Matching — Contexto VIP", () => {
  it("deve priorizar driver ELITE (VIP) como primeiro a receber offer", async () => {
    // Driver ELITE — deve receber a offer primeiro
    const eliteDriverUser = await prisma.user.create({
      data: {
        name: "TEST_Driver Elite",
        email: "TEST_elite@vip.com",
        phone: "TEST_33000000001",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "ELITE",
            isActive: true,
          },
        },
      },
      include: { driver: true },
    });

    // Driver INICIANTE — recebe offer depois do ELITE
    const commonDriverUser = await prisma.user.create({
      data: {
        name: "TEST_Driver Comum",
        email: "TEST_comum@vip.com",
        phone: "TEST_33000000002",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "INICIANTE",
            isActive: true,
          },
        },
      },
      include: { driver: true },
    });

    // Passageiro sem indicação → matching vai para GENERAL com filtro VIP
    const passenger = await prisma.passenger.create({
      data: {
        referralCode: "ref-vip-" + Date.now(),
        publicSlug:   "slug-vip-" + Date.now(),
        user: {
          create: {
            name: "TEST_Passageiro VIP",
            email: "TEST_passageiro@vip.com",
            phone: "TEST_33000000003",
            role: "PASSENGER",
          },
        },
      },
    });

    // Scope matching to only these two test drivers — prevents real drivers
    // (e.g. Pedro Paulo, who may also be ELITE) from polluting the pool.
    const candidateDriverIds = [
      eliteDriverUser.driver!.id,
      commonDriverUser.driver!.id,
    ];

    const response = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Barra da Tijuca",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 90_000_000).toISOString(),
        originLat: -22.9068, originLng: -43.1729,
        destinationLat: -22.8833, destinationLng: -43.1072,
        context: {
          vip: true,
          airport: false,
          pet: false,
          luggage: false,
        },
        candidateDriverIds,
      });

    expect(response.status).toBe(201);

    // Governed sequential dispatch: only the highest-priority candidate
    // (ELITE driver) receives the first offer. The common driver is queued
    // and would only be dispatched if the elite offer expires/is rejected.
    const offers = await waitForOffers(response.body.ride.id, 1);

    expect(offers.length).toBe(1);

    // Refetch eliteDriverUser to ensure driver relation is populated
    const eliteDriver = await prisma.user.findUnique({
      where: { id: eliteDriverUser.id },
      include: { driver: true },
    });

    // The single dispatched offer must be for the ELITE driver (VIP priority).
    expect(offers[0].driverId).toBe(eliteDriver!.driver!.id);
  });
});

