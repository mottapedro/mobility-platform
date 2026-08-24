// Sanidade de preço da quote — Fase E (regressão da base (0,0)).
//
// A corrida `fa05d8a0-...` foi precificada com perna M→A de 5.325,4 km porque
// a base operacional do M1 estava persistida com lat/lng = (0,0): o haversine
// de (0,0) até o Rio de Janeiro produziu legCostMtoACents = 639.048 e o preço
// exibido virou R$ 6.428,98. O contrato de composição é:
//
//   grossFinalCents    = legCostMtoACents + legPriceAtoBCents
//   priceEstimated     = grossFinalCents / 100        (espelho, em reais)
//
// Este spec prova que: (1) base (0,0) legada → origem M UNRESOLVED → 422 e
// nenhuma quote órfã; (2) base com coordenadas reais → quote com gross em
// dezenas de reais e espelho priceEstimated coerente.

/// <reference types="jest" />
import request from "supertest";
import { app } from "../src/app";
import { prisma, cleanTestData } from "./setup";
import { DriverOperationalBaseService } from "../src/domain/driver/DriverOperationalBaseService";
import { AuthSessionService } from "../src/domain/auth/AuthSessionService";
import { AuthTokenService } from "../src/domain/auth/AuthTokenService";

jest.setTimeout(20000);

const baseService = new DriverOperationalBaseService();

let seq = 0;
function tag() {
  seq += 1;
  return `${Date.now()}.${seq}`;
}

async function createDriver(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Price Sanity Driver",
      email,
      phone: "1191111000",
      role: "DRIVER",
      driver: {
        create: { experienceLevel: "PROFISSIONAL", isActive: true },
      },
    },
    include: { driver: true },
  });
  return user.driver!.id;
}

async function createReferredPassenger(
  email: string,
  referredByDriverId: string,
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Price Sanity Passenger",
      email,
      phone: "1192222000",
      role: "PASSENGER",
    },
  });
  const passenger = await prisma.passenger.create({
    data: {
      userId: user.id,
      referralCode: `ps-psg-${tag()}`,
      publicSlug: `ps-psg-${tag()}`,
      referredByDriverId,
    },
  });
  return passenger.id;
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

async function bearerForPassenger(passengerId: string) {
  const passenger = await prisma.passenger.findUniqueOrThrow({
    where: { id: passengerId },
    select: { userId: true },
  });
  const session = await new AuthSessionService().createSession(passenger.userId);
  return new AuthTokenService().issueAccessToken({
    userId: passenger.userId,
    sessionId: session.session.id,
  });
}

describe("Fase E — regressão: base operacional (0,0) é origem inválida", () => {
  it("base legada com lat/lng 0,0 → SCHEDULED 422 QUOTE_UNAVAILABLE, zero quotes/rides", async () => {
    const m1 = await createDriver(`price.degen.${tag()}@test.com`);
    // Linha suja legada — inserida direto no banco, como o PUT com o bug antigo
    // produzia (lat/lng = 0 fabricados no fallback sem chave do Google).
    await prisma.driverOperationalBase.create({
      data: {
        driverId: m1,
        formattedAddress: "Rua Projetada C, 56 - Praça Seca",
        providerPlaceId: "ChIJ_legacy_0_0",
        latitude: 0,
        longitude: 0,
      },
    });
    const passenger = await createReferredPassenger(
      `price.psg.degen.${tag()}@test.com`,
      m1,
    );

    const res = await request(app)
      .post("/rides")
      .send(rideBody(passenger, new Date(Date.now() + 90_000_000).toISOString()));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("QUOTE_UNAVAILABLE");

    const rides = await prisma.rideRequest.findMany({
      where: { passengerId: passenger },
    });
    expect(rides).toHaveLength(0);
    const quotes = await prisma.rideQuote.findMany({
      where: { pricingDriverId: m1 },
    });
    expect(quotes).toHaveLength(0);
  });

  it("base com coordenadas reais → quote sã (gross em dezenas de reais) + espelho priceEstimated", async () => {
    const m1 = await createDriver(`price.sane.${tag()}@test.com`);
    await baseService.save(m1, {
      address: "Base Centro",
      lat: -23.55,
      lng: -46.63,
    });
    const passenger = await createReferredPassenger(
      `price.psg.sane.${tag()}@test.com`,
      m1,
    );

    const res = await request(app)
      .post("/rides")
      .send(rideBody(passenger, new Date(Date.now() + 90_000_000).toISOString()));

    expect(res.status).toBe(201);
    expect(res.body.rideQuote.status).toBe("QUOTED");

    const quote = await prisma.rideQuote.findUniqueOrThrow({
      where: { id: res.body.rideQuote.id },
    });

    // Contrato de composição: gross = M→A + A→B (nunca outra unidade).
    expect(quote.grossFinalCents).toBe(
      quote.legCostMtoACents + quote.legPriceAtoBCents,
    );
    // A origem M é a própria origem da corrida → deslocamento M→A irrelevante.
    expect(quote.distanceMtoAKm).toBe(0);
    expect(quote.legCostMtoACents).toBe(0);
    // Sanidade: quote em dezenas de reais, jamais milhares (regressão (0,0)).
    expect(quote.grossFinalCents).toBeLessThan(50_000);
    // Espelho em reais persistido no RideRequest (fonte do card legado).
    expect(res.body.ride.priceEstimated).toBe(quote.grossFinalCents / 100);

    // O mesmo valor correto volta no GET — base da renderização do card.
    const token = await bearerForPassenger(passenger);
    const get = await request(app)
      .get(`/rides/${quote.rideRequestId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body.priceEstimated).toBe(quote.grossFinalCents / 100);
  });
});
