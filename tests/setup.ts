import { disconnectPrisma, prisma } from "../src/infra/prisma/client";
import { clearPendingReferralFallbacks } from "../src/application/use-cases/MatchRideUseCase";

export { prisma };

// TEST DATA POLICY — DO NOT REMOVE
//
// Production drivers use @driver.com and mottapedro01@gmail.com.
// ALL test-created records must use one of the TEST_EMAIL_DOMAINS below.
// The cleanup helpers delete ONLY those records.
// Production data (Pedro Paulo Motta, João Luiz, etc.) is NEVER touched.
//
// FORBIDDEN in tests:
//   prisma.*.deleteMany({})          ← no naked deleteMany
//   prisma.$executeRaw("TRUNCATE…")  ← no truncate
//   prisma.user.deleteMany()         ← no unfiltered deleteMany

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
    await prisma.rideRequest.deleteMany({ where: { id: { in: testRideRequestIds } } });
  }
  if (testPassengerIds.length > 0) {
    // Null out self-referential FK before deleting — prevents FK constraint error
    // when multiple test passengers reference each other within the same batch.
    await prisma.passenger.updateMany({
      where: { id: { in: testPassengerIds } },
      data: { referredByPassengerId: null },
    });
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
  await prisma.$connect();
});

afterAll(async () => {
  await disconnectPrisma();
});

beforeEach(async () => {
  clearPendingReferralFallbacks();
  await cleanTestData();
});

afterEach(() => {
  clearPendingReferralFallbacks();
});


