import {
  OwnershipType,
  PaymentLifecycle,
  PAYMENT_LIFECYCLE_TRANSITIONS,
  RideLifecycle,
  RIDE_LIFECYCLE_TRANSITIONS,
  DomainEventType,
  isValidPaymentTransition,
  isValidRideTransition,
} from "../../src/shared/enums";

describe("Aliado V2 — Stage 2.A — enum centralization", () => {
  describe("OwnershipType", () => {
    it("exposes the five canonical ownership categories", () => {
      expect(Object.values(OwnershipType).sort()).toEqual(
        [
          "ROOT_DRIVER",
          "INHERITED_DRIVER",
          "DIRECT_PASSENGER",
          "INHERITED_PASSENGER",
          "LATERAL",
        ].sort(),
      );
    });
  });

  describe("DomainEventType", () => {
    it("includes the new Aliado V2 lifecycle events", () => {
      const required = [
        "PAYMENT_INTENT_CREATED",
        "PIX_QRCODE_GENERATED",
        "PAYMENT_CONFIRMED",
        "PAYMENT_FAILED",
        "RIDE_SETTLED",
        "REWARD_DISTRIBUTED",
        "OFFER_CREATED",
        "RIDE_FINALIZED",
        "SETTLEMENT_CONFIRMED",
        "LINEAGE_RESOLVED",
        "SKILL_ASSIGNED",
      ];
      required.forEach((value) => {
        expect(Object.values(DomainEventType)).toContain(value);
      });
    });
  });

  describe("RideLifecycle transitions", () => {
    it("allows the pure ride lifecycle PENDING → ACCEPTED → IN_PROGRESS → COMPLETED", () => {
      const happyPath: RideLifecycle[] = [
        RideLifecycle.PENDING,
        RideLifecycle.ACCEPTED,
        RideLifecycle.IN_PROGRESS,
        RideLifecycle.COMPLETED,
      ];
      for (let i = 0; i < happyPath.length - 1; i++) {
        expect(isValidRideTransition(happyPath[i], happyPath[i + 1])).toBe(
          true,
        );
      }
    });

    it("forbids COMPLETED → PENDING", () => {
      expect(
        isValidRideTransition(RideLifecycle.COMPLETED, RideLifecycle.PENDING),
      ).toBe(false);
    });

    it("allows cancellation from active lifecycle states", () => {
      for (const active of [
        RideLifecycle.PENDING,
        RideLifecycle.ACCEPTED,
        RideLifecycle.IN_PROGRESS,
      ]) {
        expect(isValidRideTransition(active, RideLifecycle.CANCELLED)).toBe(true);
      }
    });

    it("treats COMPLETED and CANCELLED as terminal", () => {
      for (const terminal of [
        RideLifecycle.COMPLETED,
        RideLifecycle.CANCELLED,
      ]) {
        expect(RIDE_LIFECYCLE_TRANSITIONS[terminal]).toEqual([]);
      }
    });
  });

  describe("PaymentLifecycle transitions", () => {
    it("allows PENDING → CONFIRMED", () => {
      expect(
        isValidPaymentTransition(
          PaymentLifecycle.PENDING,
          PaymentLifecycle.CONFIRMED,
        ),
      ).toBe(true);
    });

    it("allows FAILED → PENDING as retry path", () => {
      expect(
        isValidPaymentTransition(
          PaymentLifecycle.FAILED,
          PaymentLifecycle.PENDING,
        ),
      ).toBe(true);
    });

    it("forbids CONFIRMED → anything", () => {
      expect(PAYMENT_LIFECYCLE_TRANSITIONS.CONFIRMED).toEqual([]);
    });

    it("forbids CANCELLED → anything", () => {
      expect(PAYMENT_LIFECYCLE_TRANSITIONS.CANCELLED).toEqual([]);
    });
  });
});
