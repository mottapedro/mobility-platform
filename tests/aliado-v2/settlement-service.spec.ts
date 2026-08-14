/**
 * SettlementService — integration tests (ADR-001 + ADR-002 v1.1)
 *
 * Requires DB (uses prisma from tests/setup).
 * RevenuePolicy ROOT_DRIVER_STANDARD is installed and cleaned per test.
 *
 * Expected values with ROOT_DRIVER_STANDARD (500 bps):
 *   platform = R$2,50 (250 cents) fixed
 *   root     = floor(driverNetAmount × 500 / 10_000)
 *   driver   = driverNetAmount − root
 */
import bcrypt from "bcrypt";
import { DomainEventType, RideStatus } from "../../src/shared/enums";
import { cleanTestData, prisma } from "../setup";
import { useRevenuePolicyFixture } from "../fixtures/revenue-policy.fixture";
import { createEventBus } from "../../src/domain/shared/events/EventBus";
import { settleConfirmedPayment } from "../../src/domain/payment/SettlementService";
import { PLATFORM_FEE_CENTS } from "../../src/domain/payment/RevenueSplitService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeDriver(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

async function makePassenger(email: string, rootDriverId: string | null) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.passenger.create({
    data: {
      userId: u.id,
      referralCode: `r-${u.id.slice(0, 6)}`,
      publicSlug: `s-${u.id.slice(0, 6)}`,
      rootDriverId: rootDriverId ?? undefined,
    },
  });
}

async function makeRide(passengerId: string, driverId: string | null) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(),
      status: RideStatus.COMPLETED,
      selectedDriverId: driverId ?? undefined,
    },
  });
}

async function makeIntent(rideRequestId: string, amountCents: number) {
  return prisma.paymentIntent.create({
    data: {
      rideRequestId,
      amountCents,
      status: "CONFIRMED",
      externalId: `pix_${rideRequestId}`,
      confirmedAt: new Date(),
    },
  });
}

/** Calcula os splits esperados para o totalCents + rootDriverId usando ROOT_DRIVER_STANDARD. */
function expectedSplits(totalCents: number, hasRoot: boolean) {
  const driverNetAmount = totalCents - PLATFORM_FEE_CENTS;
  const rootDriverCents = hasRoot ? Math.floor((driverNetAmount * 500) / 10_000) : 0;
  return {
    platformCents: PLATFORM_FEE_CENTS,
    driverNetAmount,
    rootDriverCents,
    driverCents: driverNetAmount - rootDriverCents,
  };
}

// ---------------------------------------------------------------------------
// Setup: garante que ROOT_DRIVER_STANDARD existe no banco
// ---------------------------------------------------------------------------

const revenuePolicyFixture = useRevenuePolicyFixture(prisma, cleanTestData);

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe("SettlementService (V2 — RevenuePolicy + ValidationGate)", () => {
  it("cria Settlement com splits corretos quando rootDriverId está presente", async () => {
    const driver = await makeDriver("settle.driver@test.com");
    const root = await makeDriver("settle.root@test.com");
    const passenger = await makePassenger("settle.passenger@test.com", root.id);
    const ride = await makeRide(passenger.id, driver.id);
    const intent = await makeIntent(ride.id, 10_000);

    const result = await settleConfirmedPayment(intent.id, createEventBus());
    const exp = expectedSplits(10_000, true);

    expect(result.totalCents).toBe(10_000);
    expect(result.platformCents).toBe(exp.platformCents);
    expect(result.driverCents).toBe(exp.driverCents);
    expect(result.rootDriverCents).toBe(exp.rootDriverCents);
    expect(result.rootDriverId).toBe(root.id);
    // Auditabilidade: política registrada no Settlement (ADR-002 §§5 + usuário)
    expect(result.revenuePolicyId).toBe(revenuePolicyFixture.policyId);
    expect(result.revenuePolicyVersion).toBe(1);
  });

  it("cria 3 RevenueSplit rows quando rootDriverId está presente", async () => {
    const driver = await makeDriver("settle.3rows.driver@test.com");
    const root = await makeDriver("settle.3rows.root@test.com");
    const passenger = await makePassenger("settle.3rows.passenger@test.com", root.id);
    const ride = await makeRide(passenger.id, driver.id);
    const intent = await makeIntent(ride.id, 10_000);

    const result = await settleConfirmedPayment(intent.id, createEventBus());

    const splits = await prisma.revenueSplit.findMany({
      where: { settlementId: result.id },
      orderBy: { beneficiaryType: "asc" },
    });
    expect(splits).toHaveLength(3);
    const types = splits.map((s) => s.beneficiaryType).sort();
    expect(types).toEqual(["DRIVER", "PLATFORM", "ROOT_DRIVER"]);
  });

  it("cria 2 RevenueSplit rows quando rootDriverId é null", async () => {
    const driver = await makeDriver("settle.2rows.driver@test.com");
    const passenger = await makePassenger("settle.2rows.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);
    const intent = await makeIntent(ride.id, 5_000);

    const result = await settleConfirmedPayment(intent.id, createEventBus());

    const splits = await prisma.revenueSplit.findMany({
      where: { settlementId: result.id },
    });
    expect(splits).toHaveLength(2);
    expect(result.rootDriverCents).toBe(0);
    expect(result.platformCents).toBe(PLATFORM_FEE_CENTS);
    expect(result.driverCents).toBe(5_000 - PLATFORM_FEE_CENTS);
  });

  it("invariante I-4: platform + driver + root = total em qualquer caso", async () => {
    for (const [total, withRoot] of [[3_000, false], [10_000, true], [50_000, true]] as const) {
      const driver = await makeDriver(`settle.inv4.${total}.driver@test.com`);
      const root = withRoot ? await makeDriver(`settle.inv4.${total}.root@test.com`) : null;
      const passenger = await makePassenger(`settle.inv4.${total}.pass@test.com`, root?.id ?? null);
      const ride = await makeRide(passenger.id, driver.id);
      const intent = await makeIntent(ride.id, total);

      const result = await settleConfirmedPayment(intent.id, createEventBus());
      expect(result.platformCents + result.driverCents + result.rootDriverCents).toBe(total);
    }
  });

  it("publica RIDE_SETTLED e REWARD_DISTRIBUTED", async () => {
    const driver = await makeDriver("settle.events.driver@test.com");
    const root = await makeDriver("settle.events.root@test.com");
    const passenger = await makePassenger("settle.events.passenger@test.com", root.id);
    const ride = await makeRide(passenger.id, driver.id);
    const intent = await makeIntent(ride.id, 2_000);

    const bus = createEventBus();
    const seen: DomainEventType[] = [];
    bus.subscribe(DomainEventType.RIDE_SETTLED, async () => { seen.push(DomainEventType.RIDE_SETTLED); });
    bus.subscribe(DomainEventType.REWARD_DISTRIBUTED, async () => { seen.push(DomainEventType.REWARD_DISTRIBUTED); });

    await settleConfirmedPayment(intent.id, bus);
    expect(seen).toContain(DomainEventType.RIDE_SETTLED);
    expect(seen).toContain(DomainEventType.REWARD_DISTRIBUTED);
  });

  it("é idempotente — segunda chamada retorna o Settlement existente", async () => {
    const driver = await makeDriver("settle.idem.driver@test.com");
    const passenger = await makePassenger("settle.idem.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);
    const intent = await makeIntent(ride.id, 3_000);

    const a = await settleConfirmedPayment(intent.id, createEventBus());
    const b = await settleConfirmedPayment(intent.id, createEventBus());
    expect(a.id).toBe(b.id);

    const count = await prisma.settlement.count({ where: { paymentIntentId: intent.id } });
    expect(count).toBe(1);
  });

  it("recusa liquidar PaymentIntent não-CONFIRMED", async () => {
    const driver = await makeDriver("settle.pending.driver@test.com");
    const passenger = await makePassenger("settle.pending.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);
    const pending = await prisma.paymentIntent.create({
      data: { rideRequestId: ride.id, amountCents: 1_000, status: "PENDING" },
    });

    await expect(settleConfirmedPayment(pending.id, createEventBus())).rejects.toThrow();
  });

  it("Model B: corrida permanece COMPLETED após Settlement (status não muda para PAID)", async () => {
    const driver = await makeDriver("settle.modelb.driver@test.com");
    const passenger = await makePassenger("settle.modelb.passenger@test.com", null);
    const ride = await makeRide(passenger.id, driver.id);
    const intent = await makeIntent(ride.id, 5_000);

    await settleConfirmedPayment(intent.id, createEventBus());

    const updated = await prisma.rideRequest.findUnique({ where: { id: ride.id } });
    // Settlement não altera o status da corrida (ADR-001 §4 Model B)
    expect(updated?.status).toBe(RideStatus.COMPLETED);
  });
});
