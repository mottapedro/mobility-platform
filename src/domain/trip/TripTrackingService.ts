import { prisma } from "../../infra/prisma/client";
import { pushService } from "../../infra/push/PushNotificationService";
import { buildPassengerEnRouteNotification } from "./notifications/TripNotificationPayload";

interface PingInput {
  lat:        number;
  lng:        number;
  recordedAt: Date;
}

export interface LatestLocation {
  hasLocation: boolean;
  rideRequestId: string;
  driverId?: string;
  lat?: number;
  lng?: number;
  recordedAt?: Date;
  receivedAt?: Date;
  source?: string;
}

/**
 * Returns the most recent DriverLocationPing for a ride.
 * Ordering: recordedAt desc, with receivedAt as tiebreak (recordedAt may be
 * client-supplied and non-monotonic across offline/online flushes).
 * Read-only — never infers, never fabricates.
 */
export async function getLatestLocation(rideRequestId: string): Promise<LatestLocation | null> {
  const ping = await prisma.driverLocationPing.findFirst({
    where:  { rideRequestId },
    orderBy: [{ recordedAt: "desc" }, { receivedAt: "desc" }],
  });
  if (!ping) return null;
  return {
    hasLocation: true,
    rideRequestId: ping.rideRequestId,
    driverId: ping.driverId,
    lat: ping.lat,
    lng: ping.lng,
    recordedAt: ping.recordedAt,
    receivedAt: ping.receivedAt,
    source: ping.source,
  };
}

export async function recordPing(
  rideRequestId: string,
  driverId: string,
  ping: PingInput,
  source: "LIVE" | "OFFLINE_CACHE" = "LIVE",
): Promise<void> {
  const isFirst = await isFirstPingForRide(rideRequestId);

  await prisma.driverLocationPing.create({
    data: { rideRequestId, driverId, ...ping, source },
  });

  if (isFirst) {
    await triggerEnRouteNotification(rideRequestId);
  }
}

export async function recordBulkPings(
  rideRequestId: string,
  driverId: string,
  pings: PingInput[],
): Promise<void> {
  const isFirst = await isFirstPingForRide(rideRequestId);
  const sorted = [...pings].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());

  await prisma.driverLocationPing.createMany({
    data: sorted.map(p => ({ rideRequestId, driverId, ...p, source: "OFFLINE_CACHE" as const })),
    skipDuplicates: true,
  });

  if (isFirst) {
    await triggerEnRouteNotification(rideRequestId);
  }
}

async function isFirstPingForRide(rideRequestId: string): Promise<boolean> {
  const count = await prisma.driverLocationPing.count({ where: { rideRequestId } });
  return count === 0;
}

async function triggerEnRouteNotification(rideRequestId: string): Promise<void> {
  const ride = await prisma.rideRequest.findUnique({
    where:  { id: rideRequestId },
    select: { passenger: { select: { userId: true } } },
  });
  if (!ride?.passenger?.userId) return;

  await pushService.send(
    ride.passenger.userId,
    buildPassengerEnRouteNotification(rideRequestId),
  );
}
