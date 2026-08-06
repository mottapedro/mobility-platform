import { prisma } from "../../infra/prisma/client";
import { pushService } from "../../infra/push/PushNotificationService";
import { buildPassengerEnRouteNotification } from "./notifications/TripNotificationPayload";

interface PingInput {
  lat:        number;
  lng:        number;
  recordedAt: Date;
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
