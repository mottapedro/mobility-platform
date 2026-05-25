import { ActorType } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import { DriverRootResolutionError } from "./errors";

type Db = Pick<typeof prisma, "driver" | "driverReferral" | "passenger" | "referralRelationship">;

/**
 * Resolves the operational root driver in the Aliado network for any actor.
 *
 * Rules:
 *  - A driver with no upstream referrer IS the root.
 *  - For a driver with upstream edges in DriverReferral, the root is the
 *    referrer at the highest level (deepest ancestor).
 *  - For a passenger, the root is resolved through:
 *      a) existing `rootDriverId` if already set,
 *      b) otherwise via direct `referredByDriverId` → that driver's root,
 *      c) otherwise via inviter passenger's root,
 *      d) otherwise null (no operational root yet).
 */
export async function resolveDriverRoot(
  actorType: ActorType,
  actorId: string,
  db: Db = prisma
): Promise<string | null> {
  if (actorType === ActorType.DRIVER) {
    return resolveDriverRootForDriver(actorId, db);
  }
  return resolveDriverRootForPassenger(actorId, db);
}

async function resolveDriverRootForDriver(
  driverId: string,
  db: Db
): Promise<string> {
  const driver = await db.driver.findUnique({
    where: { id: driverId },
    select: { id: true, referredByDriverId: true },
  });
  if (!driver) {
    throw new DriverRootResolutionError(`Driver ${driverId} not found`);
  }
  if (!driver.referredByDriverId) {
    return driver.id;
  }

  // Walk closure: highest-level edge where this driver is the referred party
  // points to the deepest ancestor = operational root.
  const deepest = await db.driverReferral.findFirst({
    where: { referredDriverId: driverId },
    orderBy: { level: "desc" },
    select: { referrerDriverId: true },
  });
  if (deepest) {
    return deepest.referrerDriverId;
  }
  // Fallback: walk parent chain (defensive — should not happen if closure intact)
  return resolveDriverRootForDriver(driver.referredByDriverId, db);
}

async function resolveDriverRootForPassenger(
  passengerId: string,
  db: Db
): Promise<string | null> {
  const passenger = await db.passenger.findUnique({
    where: { id: passengerId },
    select: {
      id: true,
      rootDriverId: true,
      referredByDriverId: true,
      referredByPassengerId: true,
    },
  });
  if (!passenger) {
    throw new DriverRootResolutionError(`Passenger ${passengerId} not found`);
  }
  if (passenger.rootDriverId) return passenger.rootDriverId;
  if (passenger.referredByDriverId) {
    return resolveDriverRootForDriver(passenger.referredByDriverId, db);
  }
  if (passenger.referredByPassengerId) {
    return resolveDriverRootForPassenger(passenger.referredByPassengerId, db);
  }
  return null;
}
