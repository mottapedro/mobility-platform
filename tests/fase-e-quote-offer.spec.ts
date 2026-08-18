// Fase E — fluxo bifásico da quote de oferta (contrato revisado).
//
//   POST /rides (M1 com referência válida)  → RideQuote QUOTED + ZERO ofertas.
//   POST /rides/:id/confirm-quote           → QUOTED → AGREED + primeira oferta.
//
// Cobre: prioridade de origem por modo (IMMEDIATE x SCHEDULED), recebível V2
// (Settlement), 422 sem origem M válida e ausência de fallback clássico.

/// <reference types="jest" />
import request from "supertest";
import { PLATFORM_FEE_CENTS } from "../src/domain/payment/RevenueSplitService";
import { app } from "../src/app";
import { cleanTestData, prisma } from "./setup";
import { DriverCurrentLocationService } from "../src/domain/driver/DriverCurrentLocationService";
import { DriverOperationalBaseService } from "../src/domain/driver/DriverOperationalBaseService";
import { useRevenuePolicyFixture } from "./fixtures/revenue-policy.fixture";
import { matchingJobScheduler } from "../src/infra/async/MatchingJobScheduler";

jest.setTimeout(20000);

const baseService = new DriverOperationalBaseService();
const locationService = new DriverCurrentLocationService();

const policyFixture = useRevenuePolicyFixture(prisma, cleanTestData);

let seq = 0;
function tag() {
  seq += 1;
  return `${Date.now()}.${seq}`;
}

async function createDriver(email: string) {
  const user = await prisma.user.create({
    data: {
      name: "Fase E Driver",
      email,
      phone: "1191111000",
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
  return user.driver!;
}

async function createReferredPassenger(
  email: string,
  referredByDriverId: string,
  rootDriverId?: string,
) {
  const user = await prisma.user.create({
    data: {
      name: "Fase E Passageiro",
      email,
      phone: "1192222000",
      role: "PASSENGER",
    },
  });
  const suffix = tag();
  return prisma.passenger.create({
    data: {
      userId: user.id,
      referralCode: `fe-psg-${suffix}`,
      publicSlug: `fe-psg-${suffix}`,
      referredByDriverId,
      ...(rootDriverId ? { rootDriverId } : {}),
    },
  });
}

function rideBody(passengerId: string, scheduledAt?: string) {
  return {
    passengerId,
    origin: "Zona Norte",
    destination: "Centro",
    scheduledAt,
    originLat: -23.55,
    originLng: -46.63,
    destinationLat: -23.9,
    destinationLng: -46.65,
  };
}

function confirmQuote(rideId: string) {
  return request(app).post(`/rides/${rideId}/confirm-quote`);
}

/** Recebível esperado pelo contrato V2 (Settlement): gross − fee, fatia root em 500bps. */
async function expectedV2Receivable(gross: number, rootDriverId: string | null) {
  const policy = await prisma.revenuePolicy.findUniqueOrThrow({
    where: { id: policyFixture.policyId },
  });
  const driverNet = gross - PLATFORM_FEE_CENTS;
  const rootCents =
    rootDriverId !== null
      ? Math.floor((driverNet * policy.rootDriverBps) / 10_000)
      : 0;
  return driverNet - rootCents;
}

describe("Fase E — POST /rides emite RideQuote QUOTED sem ofertas (bifase)", () => {
  it("IMMEDIATE com posição fresca → QUOTED/CURRENT_LOCATION + zero ofertas; confirms AGREED + primeira oferta", async () => {
    const m1 = await createDriver(`fe.loc.${tag()}@test.com`);
    const root = await createDriver(`fe.root.${tag()}@test.com`);
    await locationService.record({
      driverId: m1.id,
      latitude: -23.55,
      longitude: -46.63,
    });
    const passenger = await createReferredPassenger(
      `fe.psg.loc.${tag()}@test.com`,
      m1.id,
      root.id,
    );

    const res = await request(app)
      .post("/rides")
      .send(rideBody(passenger.id));

    // POST → quote QUOTED, sem AGREED e sem ofertas.
    expect(res.status).toBe(201);
    expect(res.body.rideQuote).toBeTruthy();
    expect(res.body.rideQuote.status).toBe("QUOTED");

    const quote = await prisma.rideQuote.findUnique({
      where: { id: res.body.rideQuote.id },
    });
    expect(quote).toBeTruthy();
    expect(quote!.pricingDriverId).toBe(m1.id);
    expect(quote!.originMSource).toBe("CURRENT_LOCATION");
    expect(quote!.status).toBe("QUOTED");
    expect(quote!.agreedAt).toBeNull();

    const offersBefore = await prisma.rideOffer.findMany({
      where: { rideRequestId: quote!.rideRequestId },
    });
    expect(offersBefore).toHaveLength(0);

    // Composição determinística: gross = perna M→A + perna A→B.
    expect(quote!.grossFinalCents).toBe(
      quote!.legCostMtoACents + quote!.legPriceAtoBCents,
    );

    // Confirmação do passageiro → QUOTED → AGREED + primeira oferta.
    const confirm = await confirmQuote(quote!.rideRequestId);
    expect(confirm.status).toBe(200);

    const agreed = await prisma.rideQuote.findUniqueOrThrow({
      where: { id: quote!.id },
    });
    expect(agreed.status).toBe("AGREED");
    expect(agreed.agreedAt).toBeInstanceOf(Date);

    const offer = await prisma.rideOffer.findFirstOrThrow({
      where: { rideRequestId: quote!.rideRequestId },
    });
    expect(offer.driverId).toBe(m1.id);
    expect(offer.driverReceivableAmountCents).toBe(
      agreed.driverReceivableAmountCents,
    );
    expect(offer.driverToPickupDistanceKm).toBe(agreed.distanceMtoAKm);
    expect(offer.rideDistanceKm).toBe(agreed.distanceAtoBKm);

    const ride = await prisma.rideRequest.findUniqueOrThrow({
      where: { id: quote!.rideRequestId },
    });
    expect(ride.status).toBe("WAITING_REFERRAL");
    expect(ride.currentDispatchStage).toBe("REFERRAL_DIRECT");
    expect(ride.currentCandidateDriverId).toBe(m1.id);
  });

  it("confirm idempotente — retry não duplica oferta", async () => {
    const m1 = await createDriver(`fe.retry.${tag()}@test.com`);
    await baseService.save(m1.id, {
      address: "Base Centro",
      lat: -23.55,
      lng: -46.63,
    });
    const passenger = await createReferredPassenger(
      `fe.psg.retry.${tag()}@test.com`,
      m1.id,
    );

    const res = await request(app)
      .post("/rides")
      .send(rideBody(passenger.id));
    expect(res.status).toBe(201);

    const first = await confirmQuote(res.body.ride.id);
    expect(first.status).toBe(200);
    const retry = await confirmQuote(res.body.ride.id);
    expect(retry.status).toBe(200);

    const offers = await prisma.rideOffer.findMany({
      where: { rideRequestId: res.body.ride.id },
    });
    expect(offers).toHaveLength(1);
  });
});

describe("Fase E — prioridade da origem por modo", () => {
  it("IMMEDIATE com posição fresca + base → CURRENT_LOCATION vence", async () => {
    const m1 = await createDriver(`fe.fresh.wins.${tag()}@test.com`);
    await baseService.save(m1.id, {
      address: "Base Centro",
      lat: -23.55,
      lng: -46.63,
    });
    await locationService.record({
      driverId: m1.id,
      latitude: -22.9,
      longitude: -43.17,
    });
    const passenger = await createReferredPassenger(
      `fe.psg.freshwins.${tag()}@test.com`,
      m1.id,
    );

    const res = await request(app)
      .post("/rides")
      .send(rideBody(passenger.id));

    expect(res.status).toBe(201);
    expect(res.body.rideQuote.originMSource).toBe("CURRENT_LOCATION");
  });

  it("IMMEDIATE com posição obsoleta + base → REGISTERED_BASE (fallback)", async () => {
    const m1 = await createDriver(`fe.stale.base.${tag()}@test.com`);
    await baseService.save(m1.id, {
      address: "Base Centro",
      lat: -23.55,
      lng: -46.63,
    });
    await locationService.record({
      driverId: m1.id,
      latitude: -22.9,
      longitude: -43.17,
    });
    await prisma.driverCurrentLocation.update({
      where: { driverId: m1.id },
      data: { recordedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });
    const passenger = await createReferredPassenger(
      `fe.psg.stalebase.${tag()}@test.com`,
      m1.id,
    );

    const res = await request(app)
      .post("/rides")
      .send(rideBody(passenger.id));

    expect(res.status).toBe(201);
    expect(res.body.rideQuote.originMSource).toBe("REGISTERED_BASE");
  });

  it("SCHEDULED usa somente a base operacional (posição fresca é ignorada)", async () => {
    const m1 = await createDriver(`fe.sched.base.${tag()}@test.com`);
    await baseService.save(m1.id, {
      address: "Base Centro",
      lat: -23.55,
      lng: -46.63,
    });
    await locationService.record({
      driverId: m1.id,
      latitude: -22.9,
      longitude: -43.17,
    });
    const passenger = await createReferredPassenger(
      `fe.psg.schedbase.${tag()}@test.com`,
      m1.id,
    );

    const res = await request(app)
      .post("/rides")
      .send(
        rideBody(passenger.id, new Date(Date.now() + 90_000_000).toISOString()),
      );

    expect(res.status).toBe(201);
    expect(res.body.rideQuote.originMSource).toBe("REGISTERED_BASE");

    const confirm = await confirmQuote(res.body.ride.id);
    expect(confirm.status).toBe(200);
    const offer = await prisma.rideOffer.findFirstOrThrow({
      where: { rideRequestId: res.body.ride.id },
    });
    expect(offer.driverId).toBe(m1.id);
  });
});

describe("Fase E — recebível V2 (Settlement)", () => {
  it("driverReceivableAmountCents = split V2 com fatia do root deduzida", async () => {
    const m1 = await createDriver(`fe.v2.m1.${tag()}@test.com`);
    const root = await createDriver(`fe.v2.root.${tag()}@test.com`);
    await baseService.save(m1.id, {
      address: "Base Centro",
      lat: -23.55,
      lng: -46.63,
    });
    const passenger = await createReferredPassenger(
      `fe.psg.v2.${tag()}@test.com`,
      m1.id,
      root.id,
    );

    const res = await request(app)
      .post("/rides")
      .send(rideBody(passenger.id, new Date(Date.now() + 90_000_000).toISOString()));

    expect(res.status).toBe(201);

    const quote = await prisma.rideQuote.findUniqueOrThrow({
      where: { id: res.body.rideQuote.id },
    });
    expect(quote.revenuePolicyId).toBe(policyFixture.policyId);

    const expected = await expectedV2Receivable(quote.grossFinalCents, root.id);
    expect(quote.driverReceivableAmountCents).toBe(expected);
    // A fatia do root torna o recebível menor que o V1 (gross − fee fixa).
    expect(quote.driverReceivableAmountCents).toBeLessThan(
      quote.grossFinalCents - PLATFORM_FEE_CENTS,
    );

    // Sem root econômico → same as V1 (sem fatia de root).
    const m1b = await createDriver(`fe.v2.noroot.m1.${tag()}@test.com`);
    await baseService.save(m1b.id, {
      address: "Base Centro",
      lat: -23.55,
      lng: -46.63,
    });
    const pasgNoRoot = await createReferredPassenger(
      `fe.psg.v2.noroot.${tag()}@test.com`,
      m1b.id,
    );
    const res2 = await request(app)
      .post("/rides")
      .send(
        rideBody(pasgNoRoot.id, new Date(Date.now() + 90_000_000).toISOString()),
      );
    expect(res2.status).toBe(201);
    const quote2 = await prisma.rideQuote.findUniqueOrThrow({
      where: { id: res2.body.rideQuote.id },
    });
    expect(quote2.driverReceivableAmountCents).toBe(
      quote2.grossFinalCents - PLATFORM_FEE_CENTS,
    );
  });
});

describe("Fase E — sem origem M válida (sem fallback clássico)", () => {
  it("SCHEDULED com somente posição fresca → 422 QUOTE_UNAVAILABLE e NENHUMA corrida criada", async () => {
    const m1 = await createDriver(`fe.noorigin.${tag()}@test.com`);
    await locationService.record({
      driverId: m1.id,
      latitude: -23.55,
      longitude: -46.63,
    });
    const passenger = await createReferredPassenger(
      `fe.psg.noorigin.${tag()}@test.com`,
      m1.id,
    );

    const res = await request(app)
      .post("/rides")
      .send(
        rideBody(passenger.id, new Date(Date.now() + 90_000_000).toISOString()),
      );

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("QUOTE_UNAVAILABLE");

    // Sem quote e sem corrida órfã — o fallback clássico NÃO roda.
    const rides = await prisma.rideRequest.findMany({
      where: { passengerId: passenger.id },
    });
    expect(rides).toHaveLength(0);
    const quotes = await prisma.rideQuote.findMany({
      where: { pricingDriverId: m1.id },
    });
    expect(quotes).toHaveLength(0);
  });

  it("passageiro sem M1 (sem referência) → sem quote (fluxo clássico intacto)", async () => {
    const passenger = await prisma.passenger.create({
      data: {
        referralCode: `fe-nom1-${tag()}`,
        publicSlug: `fe-nom1-${tag()}`,
        user: {
          create: {
            name: "Fase E sem M1",
            email: `fe.nom1.${tag()}@test.com`,
            phone: "1192222000",
            role: "PASSENGER",
          },
        },
      },
    });

    const res = await request(app)
      .post("/rides")
      .send(rideBody(passenger.id));

    expect(res.status).toBe(201);
    expect(res.body.rideQuote).toBeNull();

    const quotes = await prisma.rideQuote.findMany({
      where: { rideRequestId: res.body.ride.id },
    });
    expect(quotes).toHaveLength(0);
    // Sem quote → confirm é rejeitado com QUOTE_NOT_FOUND.
    const confirm = await confirmQuote(res.body.ride.id);
    expect(confirm.status).toBe(404);
    expect(confirm.body.code).toBe("QUOTE_NOT_FOUND");

    // Fluxo clássico → matching agendado de forma assíncrona. O afterEach da
    // fixture roda cleanTestData() logo após o teste: se o dispatch ainda
    // estiver em voo, ele cria RideOffer depois da limpeza das ofertas e antes
    // do deleteMany do RideRequest → FK RideOffer_rideRequestId_fkey. Drain
    // explícito (quiescência real do scheduler, sem setTimeout arbitrário).
    await matchingJobScheduler.drain();
  });
});