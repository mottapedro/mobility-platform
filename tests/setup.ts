import { disconnectPrisma, prisma } from "../src/infra/prisma/client";
import { clearPendingReferralFallbacks } from "../src/application/use-cases/MatchRideUseCase";

export { prisma };

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await disconnectPrisma();
});

beforeEach(async () => {
  clearPendingReferralFallbacks();

  // Delete in FK-safe order
  await prisma.driverAvailability.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.rideOffer.deleteMany();
  await prisma.rideRequest.deleteMany();
  await prisma.passenger.deleteMany();
  await prisma.driverReferral.deleteMany();
  await prisma.driver.deleteMany();
  await prisma.user.deleteMany();
});

afterEach(() => {
  clearPendingReferralFallbacks();
});
