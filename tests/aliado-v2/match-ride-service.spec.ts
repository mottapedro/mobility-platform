import bcrypt from "bcrypt";
import { RideStatus } from "../../src/shared/enums";
import { prisma } from "../setup";
import {
  execute as matchRide,
  MatchRideService,
} from "../../src/application/services/MatchRideService";
import { MatchRideUseCase } from "../../src/application/use-cases/MatchRideUseCase";

async function makePassenger(email: string) {
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
    },
  });
}

async function makeRide(passengerId: string) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      origin: "A",
      destination: "B",
      scheduledAt: new Date(),
      status: RideStatus.PENDING,
    },
  });
}

async function makeInactiveDriver(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `22${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
      driver: {
        create: {
          experienceLevel: "INICIANTE",
          isActive: false,
        },
      },
    },
    include: { driver: true },
  });
  return u.driver!;
}

describe("MatchRideService (application shell)", () => {
  it("exposes a static execute namespace export", () => {
    expect(typeof MatchRideService.execute).toBe("function");
    expect(MatchRideService.execute).toBe(matchRide);
  });

  it("returns matched=false / level=GENERAL when no candidate driver exists", async () => {
    const passenger = await makePassenger("mrs.empty.passenger@test.com");
    const inactiveDriver = await makeInactiveDriver("mrs.empty.driver@test.com");
    const ride = await makeRide(passenger.id);

    const result = await matchRide({
      rideId: ride.id,
      candidateDriverIds: [inactiveDriver.id],
    });

    expect(result.matched).toBe(false);
    expect(result.level).toBe("GENERAL");
    expect(result.outcome).toBe("NO_MATCH_AVAILABLE");
  });

  it("produces the same result as calling MatchRideUseCase directly (delegation parity)", async () => {
    const passenger = await makePassenger("mrs.parity.passenger@test.com");
    const inactiveDriver = await makeInactiveDriver("mrs.parity.driver@test.com");
    const ride = await makeRide(passenger.id);
    const input = { rideId: ride.id, candidateDriverIds: [inactiveDriver.id] };

    const direct = await new MatchRideUseCase().execute(input);
    const viaShell = await matchRide(input);

    expect(viaShell).toEqual(direct);
  });
});
