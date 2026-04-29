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
        referredByDriverId: driverAUser.driver!.id,
      },
    });

    const response = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Barra da Tijuca",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
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
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
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
        name: "Driver Elite",
        email: "elite@vip.com",
        phone: "33000000001",
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
    await prisma.user.create({
      data: {
        name: "Driver Comum",
        email: "comum@vip.com",
        phone: "33000000002",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "INICIANTE",
            isActive: true,
          },
        },
      },
    });

    // Passageiro sem indicação → matching vai para GENERAL com filtro VIP
    const passenger = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name: "Passageiro VIP",
            email: "passageiro@vip.com",
            phone: "33000000003",
            role: "PASSENGER",
          },
        },
      },
    });

    const response = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Barra da Tijuca",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        context: {
          vip: true,
          airport: false,
          pet: false,
          luggage: false,
        },
      });

    expect(response.status).toBe(201);

    // Aguardar matching (2 drivers → 2 offers)
    const offers = await waitForOffers(response.body.ride.id, 2);

    expect(offers.length).toBeGreaterThan(0);

    // Driver ELITE deve ter recebido offer
    const eliteOffer = offers.find(
      (o) => o.driverId === eliteDriverUser.driver!.id
    );
    expect(eliteOffer).toBeTruthy();

    // Driver ELITE deve ser o PRIMEIRO a receber (prioridade VIP)
    expect(offers[0].driverId).toBe(eliteDriverUser.driver!.id);
  });
});

