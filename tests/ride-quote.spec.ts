import { RideQuoteService } from "../src/domain/ride-quote/RideQuoteService";
import { loadRideQuoteTtlMs } from "../src/config/rideQuote";
import { prisma } from "./setup";

const service = new RideQuoteService();

let seq = 0;
function tag() {
  seq += 1;
  return `${Date.now()}.${seq}`;
}

async function makeFixtures(suffix: string) {
  const policy = await prisma.revenuePolicy.upsert({
    where: { code_version: { code: "RIDE_QUOTE_TEST_POLICY", version: 1 } },
    update: {},
    create: {
      code: "RIDE_QUOTE_TEST_POLICY",
      name: "Fase D — quote test policy",
      version: 1,
      rootDriverBps: 500,
    },
  });

  const driverUser = await prisma.user.create({
    data: {
      name: "RQ Driver",
      email: `rq.driver.${suffix}@test.com`,
      phone: "11900000001",
      role: "DRIVER",
      passwordHash: "test",
    },
  });
  const driver = await prisma.driver.create({
    data: {
      userId: driverUser.id,
      isActive: true,
      experienceLevel: "INTERMEDIARIO",
      regions: ["ZN"],
    },
  });

  const passengerUser = await prisma.user.create({
    data: {
      name: "RQ Passenger",
      email: `rq.psg.${suffix}@test.com`,
      phone: "11900000002",
      role: "PASSENGER",
    },
  });
  const passenger = await prisma.passenger.create({
    data: {
      referralCode: `rq-psg-${suffix}`,
      publicSlug: `rq-psg-${suffix}`,
      user: { connect: { id: passengerUser.id } },
    },
  });

  const ride = await prisma.rideRequest.create({
    data: {
      passengerId: passenger.id,
      origin: "A",
      destination: "B",
      originLat: -23.55,
      originLng: -46.63,
      destinationLat: -23.9,
      destinationLng: -46.65,
      distanceKm: 12,
      durationMin: 30,
    },
  });

  return { policy, driver, passenger, ride };
}

function quoteInput(rideId: string, driverId: string, policyId: string) {
  return {
    rideRequestId: rideId,
    pricingDriverId: driverId,
    originMLat: -23.546,
    originMLng: -46.612,
    originMSource: "REGISTERED_BASE",
    distanceMtoAKm: 3.2,
    distanceAtoBKm: 12,
    legCostMtoACents: 384,
    legPriceAtoBCents: 1440,
    grossFinalCents: 1824,
    revenuePolicyId: policyId,
    revenuePolicyVersion: 1,
    driverReceivableAmountCents: 1733,
  };
}

describe("Fase D — RideQuoteService (contrato persistente)", () => {
  it("issueQuote cria QUOTED com version=1 e expiresAt = createdAt + TTL (15min)", async () => {
    const { policy, driver, ride } = await makeFixtures(tag());
    const ttlMs = loadRideQuoteTtlMs();

    const quote = await service.issueQuote(quoteInput(ride.id, driver.id, policy.id));

    expect(quote.status).toBe("QUOTED");
    expect(quote.version).toBe(1);
    expect(quote.agreedAt).toBeNull();
    expect(quote.expiresAt.getTime() - quote.createdAt.getTime()).toBe(ttlMs);
    expect(quote.expiresAt).toEqual(
      new Date(quote.createdAt.getTime() + 15 * 60 * 1_000),
    );
    expect(quote.driverReceivableAmountCents).toBe(1733);
  });

  it("confirmQuote AGREED via CAS — apenas status=QUOTED, version correta e expiresAt>now", async () => {
    const { policy, driver, ride } = await makeFixtures(tag());
    const quote = await service.issueQuote(quoteInput(ride.id, driver.id, policy.id));

    const result = await service.confirmQuote({
      rideRequestId: ride.id,
      pricingDriverId: driver.id,
      expectedVersion: quote.version,
    });

    expect(result.outcome).toBe("AGREED");
    if (result.outcome !== "AGREED") return;
    expect(result.alreadyAgreed).toBe(false);
    expect(result.quote.status).toBe("AGREED");
    expect(result.quote.version).toBe(2);
    expect(result.quote.agreedAt).toBeInstanceOf(Date);

    const row = await prisma.rideQuote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(row.status).toBe("AGREED");
  });

  it("retry de quote já AGREED é idempotente — retorna o mesmo contrato", async () => {
    const { policy, driver, ride } = await makeFixtures(tag());
    const quote = await service.issueQuote(quoteInput(ride.id, driver.id, policy.id));
    await service.confirmQuote({
      rideRequestId: ride.id,
      pricingDriverId: driver.id,
      expectedVersion: 1,
    });

    const retry = await service.confirmQuote({
      rideRequestId: ride.id,
      pricingDriverId: driver.id,
      expectedVersion: 1,
    });

    expect(retry.outcome).toBe("AGREED");
    if (retry.outcome !== "AGREED") return;
    expect(retry.alreadyAgreed).toBe(true);
    expect(retry.quote.id).toBe(quote.id);
    expect(retry.quote.status).toBe("AGREED");
    expect(retry.quote.version).toBe(2);
  });

  it("quote expirada não confirma — transita para EXPIRED", async () => {
    const { policy, driver, ride } = await makeFixtures(tag());
    const quote = await service.issueQuote(quoteInput(ride.id, driver.id, policy.id));

    await prisma.rideQuote.update({
      where: { id: quote.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const result = await service.confirmQuote({
      rideRequestId: ride.id,
      pricingDriverId: driver.id,
      expectedVersion: 1,
    });

    expect(result.outcome).toBe("EXPIRED");
    if (result.outcome !== "AGREED" && result.outcome !== "NOT_FOUND") {
      expect(result.quote.status).toBe("EXPIRED");
    }
    const row = await prisma.rideQuote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(row.status).toBe("EXPIRED");
    expect(row.agreedAt).toBeNull();
  });

  it("versão errada → VERSION_CONFLICT", async () => {
    const { policy, driver, ride } = await makeFixtures(tag());
    const quote = await service.issueQuote(quoteInput(ride.id, driver.id, policy.id));

    const result = await service.confirmQuote({
      rideRequestId: ride.id,
      pricingDriverId: driver.id,
      expectedVersion: quote.version + 1,
    });

    expect(result.outcome).toBe("VERSION_CONFLICT");
  });

  it("par (corrida, driver) desconhecido → NOT_FOUND", async () => {
    const result = await service.confirmQuote({
      rideRequestId: "unknown-ride",
      pricingDriverId: "unknown-driver",
      expectedVersion: 1,
    });

    expect(result.outcome).toBe("NOT_FOUND");
  });

  it("issueQuote é idempotente — uma única quote viva por (corrida, driver)", async () => {
    const { policy, driver, ride } = await makeFixtures(tag());
    const input = quoteInput(ride.id, driver.id, policy.id);

    const first = await service.issueQuote(input);
    const second = await service.issueQuote(input);

    expect(second.id).toBe(first.id);
    const count = await prisma.rideQuote.count({
      where: { rideRequestId: ride.id, pricingDriverId: driver.id, status: "QUOTED" },
    });
    expect(count).toBe(1);
  });

  it("CAS concorrente — dois confirms, exatamente um vence, nenhum VERSION_CONFLICT", async () => {
    const { policy, driver, ride } = await makeFixtures(tag());
    const quote = await service.issueQuote(quoteInput(ride.id, driver.id, policy.id));

    const [a, b] = await Promise.all([
      service.confirmQuote({ rideRequestId: ride.id, pricingDriverId: driver.id, expectedVersion: quote.version }),
      service.confirmQuote({ rideRequestId: ride.id, pricingDriverId: driver.id, expectedVersion: quote.version }),
    ]);

    expect(a.outcome).toBe("AGREED");
    expect(b.outcome).toBe("AGREED");
    if (a.outcome !== "AGREED" || b.outcome !== "AGREED") return;
    const winners = [a, b].filter((r) => !r.alreadyAgreed);
    expect(winners).toHaveLength(1);
    expect(a.quote.id).toBe(quote.id);
    expect(b.quote.id).toBe(quote.id);
    expect(a.quote.version).toBe(2);
    expect(b.quote.version).toBe(2);

    const row = await prisma.rideQuote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(row.status).toBe("AGREED");
    expect(row.version).toBe(2);
  });
});

describe("Fase D — loadRideQuoteTtlMs", () => {
  it("default 15 minutos", () => {
    expect(loadRideQuoteTtlMs({} as NodeJS.ProcessEnv)).toBe(15 * 60 * 1_000);
  });

  it("override via RIDE_QUOTE_TTL (formato de duração)", () => {
    expect(
      loadRideQuoteTtlMs({ RIDE_QUOTE_TTL: "5m" } as NodeJS.ProcessEnv),
    ).toBe(5 * 60 * 1_000);
    expect(
      loadRideQuoteTtlMs({ RIDE_QUOTE_TTL: "1h" } as NodeJS.ProcessEnv),
    ).toBe(60 * 60 * 1_000);
  });
});