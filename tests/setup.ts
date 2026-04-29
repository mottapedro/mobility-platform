import { prisma } from "../src/infra/prisma/client";

export { prisma };

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Delete in FK-safe order
  await prisma.driverAvailability.deleteMany();
  await prisma.driverRegion.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.rideOffer.deleteMany();
  await prisma.rideRequest.deleteMany();
  await prisma.passenger.deleteMany();
  await prisma.driverReferral.deleteMany();
  await prisma.driver.deleteMany();
  await prisma.user.deleteMany();
});
