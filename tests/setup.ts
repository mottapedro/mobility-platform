import { disconnectPrisma, prisma } from "../src/infra/prisma/client";
import { clearPendingReferralFallbacks } from "../src/application/use-cases/MatchRideUseCase";
import { lifecycle } from "../src/infra/AppLifecycleManager";
import { matchingJobScheduler } from "../src/infra/async/MatchingJobScheduler";
import { referralFallbackScheduler } from "../src/infra/async/ReferralFallbackScheduler";

export { prisma };

// TEST DATA POLICY — see AGENTS.md §6 for the canonical statement.
// Summary: every test-created record MUST use an email ending in one of the
// TEST_EMAIL_DOMAINS below; cleanTestData() is the only sanctioned destructive
// operation. Naked deleteMany / TRUNCATE / unfiltered deletes are forbidden.

const TEST_EMAIL_DOMAINS = [
  "@test.com",
  "@ref.com",
  "@backfill.test",
  "@auth.com",
  "@matching.com",
  "@partner.com",
  "@vip.com",
  "@ptest.com",
  "@sqlval.com",
  "@sla.com",
];

const TEST_USER_WHERE = {
  OR: TEST_EMAIL_DOMAINS.map((domain) => ({ email: { endsWith: domain } })),
};

/**
 * Delete only records created by the test suite.
 * Targets users whose email matches TEST_EMAIL_DOMAINS.
 * Real production users are NEVER touched.
 */
export async function cleanTestData(): Promise<void> {
  const testUsers = await prisma.user.findMany({
    where: TEST_USER_WHERE,
    select: { id: true },
  });
  const testUserIds = testUsers.map((u) => u.id);

  if (testUserIds.length === 0) return;

  const testDrivers = await prisma.driver.findMany({
    where: { userId: { in: testUserIds } },
    select: { id: true },
  });
  const testDriverIds = testDrivers.map((d) => d.id);

  const testPassengerIds = (
    await prisma.passenger.findMany({
      where: { userId: { in: testUserIds } },
      select: { id: true },
    })
  ).map((p) => p.id);

  // Delete in FK-safe order — ONLY test records
  if (testDriverIds.length > 0) {
    await prisma.driverAvailability.deleteMany({ where: { driverId: { in: testDriverIds } } });
    await prisma.vehicle.deleteMany({ where: { driverId: { in: testDriverIds } } });
  }

  // Collect test rideRequest IDs BEFORE deleting offers so we can remove
  // ALL offers that reference them — including offers made by real (non-test)
  // drivers. Without this, a real driver's offer keeps a FK reference to the
  // test ride-request and the subsequent deleteMany raises:
  //   Foreign key constraint violated: RideOffer_rideRequestId_fkey
  let testRideRequestIds: string[] = [];
  if (testPassengerIds.length > 0 || testDriverIds.length > 0) {
    testRideRequestIds = (
      await prisma.rideRequest.findMany({
        where: {
          OR: [
            ...(testPassengerIds.length > 0 ? [{ passengerId: { in: testPassengerIds } }] : []),
            ...(testDriverIds.length > 0 ? [{ selectedDriverId: { in: testDriverIds } }] : []),
          ],
        },
        select: { id: true },
      })
    ).map((r) => r.id);
  }

  // Delete ALL offers that touch test data (by driver OR by rideRequest)
  if (testDriverIds.length > 0 || testRideRequestIds.length > 0) {
    await prisma.rideOffer.deleteMany({
      where: {
        OR: [
          ...(testDriverIds.length > 0 ? [{ driverId: { in: testDriverIds } }] : []),
          ...(testRideRequestIds.length > 0 ? [{ rideRequestId: { in: testRideRequestIds } }] : []),
        ],
      },
    });
  }

  // Safe to delete ride requests now that all child offers are gone
  if (testRideRequestIds.length > 0) {
    // V2 PR-2 — delete payment-domain rows attached to these rides BEFORE the
    // rideRequest deleteMany (RevenueSplit → Settlement → PaymentIntent).
    const testPaymentIntentIds = (
      await prisma.paymentIntent.findMany({
        where: { rideRequestId: { in: testRideRequestIds } },
        select: { id: true },
      })
    ).map((p) => p.id);

    if (testPaymentIntentIds.length > 0) {
      const testSettlementIds = (
        await prisma.settlement.findMany({
          where: { paymentIntentId: { in: testPaymentIntentIds } },
          select: { id: true },
        })
      ).map((s) => s.id);

      if (testSettlementIds.length > 0) {
        await prisma.revenueSplit.deleteMany({
          where: { settlementId: { in: testSettlementIds } },
        });
        await prisma.settlement.deleteMany({
          where: { id: { in: testSettlementIds } },
        });
        // Also wipe DomainEvents bound to those settlements.
        await prisma.domainEvent.deleteMany({
          where: {
            aggregateType: "Settlement",
            aggregateId: { in: testSettlementIds },
          },
        });
      }

      await prisma.paymentIntent.deleteMany({
        where: { id: { in: testPaymentIntentIds } },
      });

      await prisma.domainEvent.deleteMany({
        where: {
          aggregateType: "PaymentIntent",
          aggregateId: { in: testPaymentIntentIds },
        },
      });
    }

    // Ride-scoped DomainEvents.
    await prisma.domainEvent.deleteMany({
      where: { aggregateType: "Ride", aggregateId: { in: testRideRequestIds } },
    });

    // ADR-004: OwnershipSnapshot has FK to RideRequest — must delete before the ride.
    await prisma.ownershipSnapshot.deleteMany({
      where: { rideId: { in: testRideRequestIds } },
    });

    // Trip/GPS: DriverLocationPing has FK ON DELETE RESTRICT to RideRequest and
    // Driver — must delete before both. Also wipes pings recorded by test drivers.
    const testPingDriverIds = testDriverIds.length > 0 ? testDriverIds : [];
    if (testPingDriverIds.length > 0 || testRideRequestIds.length > 0) {
      await prisma.driverLocationPing.deleteMany({
        where: {
          OR: [
            ...(testPingDriverIds.length > 0 ? [{ driverId: { in: testPingDriverIds } }] : []),
            ...(testRideRequestIds.length > 0 ? [{ rideRequestId: { in: testRideRequestIds } }] : []),
          ],
        },
      });
    }

    // Fase D — RideQuote has FK RESTRICT to RideRequest and Driver — must delete before both.
    const testQuoteDriverIds = testDriverIds.length > 0 ? testDriverIds : [];
    if (testQuoteDriverIds.length > 0 || testRideRequestIds.length > 0) {
      await prisma.rideQuote.deleteMany({
        where: {
          OR: [
            ...(testQuoteDriverIds.length > 0
              ? [{ pricingDriverId: { in: testQuoteDriverIds } }]
              : []),
            ...(testRideRequestIds.length > 0
              ? [{ rideRequestId: { in: testRideRequestIds } }]
              : []),
          ],
        },
      });
    }

    // RI2B: remove dispatch-round dependents before their referenced rounds,
    // revisions, and rides.
    const testDemandRevisionIds = (
      await prisma.demandRevision.findMany({
        where: { rideRequestId: { in: testRideRequestIds } },
        select: { id: true },
      })
    ).map((revision) => revision.id);

    if (testDemandRevisionIds.length > 0) {
      const testDispatchRoundIds = (
        await prisma.dispatchRound.findMany({
          where: { demandRevisionId: { in: testDemandRevisionIds } },
          select: { id: true },
        })
      ).map((round) => round.id);

      if (testDispatchRoundIds.length > 0) {
        await prisma.dispatchRoundCandidate.deleteMany({
          where: { dispatchRoundId: { in: testDispatchRoundIds } },
        });
        await prisma.dispatchRoundExhaustionSummary.deleteMany({
          where: { dispatchRoundId: { in: testDispatchRoundIds } },
        });
        await prisma.dispatchRound.deleteMany({
          where: { id: { in: testDispatchRoundIds } },
        });
      }

      await prisma.demandRevision.deleteMany({
        where: { id: { in: testDemandRevisionIds } },
      });
    }

    await prisma.rideRequest.deleteMany({ where: { id: { in: testRideRequestIds } } });
  }
  if (testPassengerIds.length > 0) {
    // Null out self-referential FK before deleting — prevents FK constraint error
    // when multiple test passengers reference each other within the same batch.
    await prisma.passenger.updateMany({
      where: { id: { in: testPassengerIds } },
      data: { referredByPassengerId: null },
    });
  }

  // V2 — delete relational referral graph BEFORE passenger/driver deletes
  if (testDriverIds.length > 0 || testPassengerIds.length > 0) {
    await prisma.referralRelationship.deleteMany({
      where: {
        OR: [
          ...(testDriverIds.length > 0
            ? [{ inviterDriverId: { in: testDriverIds } }]
            : []),
          ...(testDriverIds.length > 0
            ? [{ rootDriverId: { in: testDriverIds } }]
            : []),
          ...(testDriverIds.length > 0
            ? [{
                AND: [
                  { invitedActorType: "DRIVER" as const },
                  { invitedId: { in: testDriverIds } },
                ],
              }]
            : []),
          ...(testPassengerIds.length > 0
            ? [{
                AND: [
                  { invitedActorType: "PASSENGER" as const },
                  { invitedId: { in: testPassengerIds } },
                ],
              }]
            : []),
          ...(testPassengerIds.length > 0
            ? [{
                AND: [
                  { inviterActorType: "PASSENGER" as const },
                  { inviterId: { in: testPassengerIds } },
                ],
              }]
            : []),
        ],
      },
    });
  }

  // V2 — delete DriverSkill for test drivers BEFORE driver deletes
  if (testDriverIds.length > 0) {
    await prisma.driverSkill.deleteMany({ where: { driverId: { in: testDriverIds } } });
  }

  // V2.1 (PR-3) — delete Invite rows owned by test actors BEFORE deletes.
  if (testDriverIds.length > 0 || testPassengerIds.length > 0) {
    await prisma.invite.deleteMany({
      where: {
        OR: [
          ...(testDriverIds.length > 0
            ? [{ AND: [{ ownerActorType: "DRIVER" as const }, { ownerId: { in: testDriverIds } }] }]
            : []),
          ...(testPassengerIds.length > 0
            ? [{ AND: [{ ownerActorType: "PASSENGER" as const }, { ownerId: { in: testPassengerIds } }] }]
            : []),
        ],
      },
    });
  }

  if (testPassengerIds.length > 0) {
    await prisma.passenger.deleteMany({ where: { id: { in: testPassengerIds } } });
  }
  if (testDriverIds.length > 0) {
    await prisma.driverReferral.deleteMany({
      where: {
        OR: [
          { referrerDriverId: { in: testDriverIds } },
          { referredDriverId: { in: testDriverIds } },
        ],
      },
    });
    await prisma.driver.deleteMany({ where: { id: { in: testDriverIds } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: testUserIds } } });
}

beforeAll(async () => {
  // Referral fallback registered before matching: shutdownAsync drains in
  // insertion order, and a firing referral callback enqueues matching work.
  lifecycle.registerDrainable("referralFallbackScheduler", referralFallbackScheduler);
  lifecycle.registerDrainable("matchingJobScheduler", matchingJobScheduler);
  await prisma.$connect();
});

afterAll(async () => {
  await lifecycle.shutdownAsync({ drainTimeoutMs: 5_000 });
  await disconnectPrisma();
});

beforeEach(async () => {
  clearPendingReferralFallbacks();
  await matchingJobScheduler.drain();
  await cleanTestData();
});

afterEach(() => {
  clearPendingReferralFallbacks();
});


