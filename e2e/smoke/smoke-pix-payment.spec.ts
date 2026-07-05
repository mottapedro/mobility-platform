import { prisma } from "../../tests/setup";
import { clearPendingReferralFallbacks } from "../../src/application/use-cases/MatchRideUseCase";
import { matchingJobScheduler } from "../../src/infra/async/MatchingJobScheduler";
import {
  makeDriver,
  makePassenger,
  createRide,
  setRideCompleted,
  createPaymentIntent,
  triggerPixWebhook,
  getSettlement,
} from "./support/api";

describe("Smoke: PIX payment flow", () => {
  it("creates ride → payment intent → PIX webhook → settlement (happy path)", async () => {
    const ts        = Date.now();
    const driver    = await makeDriver(`smoke.drv${ts}@test.com`);
    const passenger = await makePassenger(`smoke.psg${ts}@test.com`, driver.id);

    // Step 1 — Create ride via HTTP (validates lat/lng, runs PricingEngine)
    const ride = await createRide(passenger.id);
    expect(ride.id).toBeTruthy();
    expect(ride.priceEstimated).toBeGreaterThan(0);

    // Financial Domain v1: RideQuote DTO returned at ride creation
    expect(ride.quote).not.toBeNull();
    expect(ride.quote).toMatchObject({
      totalPassengerPrice: expect.any(Number),
      breakdown:           expect.any(Array),
      pricingVersion:      "v1",
    });

    // Drain background matching so the referral-fallback timer is cleared before
    // lifecycle shutdown — prevents a pending 300s timer from causing a pool error
    await matchingJobScheduler.drain();
    clearPendingReferralFallbacks();

    // Step 2 — Simulate ride completion (dispatch flow is out of scope for smoke)
    await setRideCompleted(ride.id);

    // Step 3 — Payment intent
    const intent = await createPaymentIntent(ride.id);
    expect(intent.status).toBe(201);
    expect(intent.body.success).toBe(true);
    expect(intent.body.qrCode).toMatch(/^000201/); // EMVCo static PIX
    expect(intent.body.totalPrice).toBeCloseTo(ride.priceEstimated!, 2);
    expect(intent.body.amount).toBeCloseTo(ride.priceEstimated!, 2);
    expect(intent.body.externalId).toBeTruthy();
    expect(Array.isArray(intent.body.breakdown)).toBe(true);
    expect(intent.body.breakdown).toHaveLength(2);

    const { externalId } = intent.body;

    // Step 4 — PIX webhook CONFIRMED
    const webhook = await triggerPixWebhook(externalId);
    expect(webhook.status).toBe(200);

    // Step 5 — Settlement (Model B: ride stays COMPLETED, payment lives in PaymentIntent)
    const settlement = await getSettlement(ride.id);
    expect(settlement.status).toBe(200);
    expect(settlement.body.totalCents).toBe(Math.round(ride.priceEstimated! * 100));
    expect(Number(settlement.body.driverCents)).toBeGreaterThan(0);
    expect(Number(settlement.body.platformCents)).toBeGreaterThan(0);
    expect(Array.isArray(settlement.body.splits)).toBe(true);

    // Idempotency: second webhook must not error
    const webhook2 = await triggerPixWebhook(externalId);
    expect(webhook2.status).toBe(200);
  });

  it("returns 422 MISSING_PRICE when ride has no price", async () => {
    const driver    = await makeDriver(`smoke.nopr.drv${Date.now()}@test.com`);
    const passenger = await makePassenger(`smoke.nopr.psg${Date.now()}@test.com`);

    // Bypass HTTP layer — create a COMPLETED ride with no priceEstimated
    const ride = await prisma.rideRequest.create({
      data: {
        passengerId:      passenger.id,
        origin:           "A",
        destination:      "B",
        scheduledAt:      new Date(),
        status:           "COMPLETED",
        selectedDriverId: driver.id,
      },
    });

    const intent = await createPaymentIntent(ride.id);
    expect(intent.status).toBe(422);
    expect(intent.body.code).toBe("MISSING_PRICE");
  });
});
