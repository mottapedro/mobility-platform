import { Router, Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";
import { recordPing, recordBulkPings, getLatestLocation } from "../../domain/trip/TripTrackingService";

export const tripRouter = Router();

tripRouter.get("/:rideId/location", async (req: Request, res: Response) => {
  const rideId = req.params["rideId"] as string;
  if (!rideId) {
    return res.status(400).json({ error: "rideId required" });
  }

  const ride = await prisma.rideRequest.findUnique({
    where: { id: rideId },
    select: { id: true },
  });
  if (!ride) {
    return res.status(404).json({ error: "RideRequest not found" });
  }

  const location = await getLatestLocation(rideId);
  if (!location) {
    return res.status(200).json({ hasLocation: false, rideId });
  }
  return res.status(200).json({
    hasLocation: true,
    rideId: location.rideRequestId,
    driverId: location.driverId,
    lat: location.lat,
    lng: location.lng,
    recordedAt: location.recordedAt?.toISOString(),
    receivedAt: location.receivedAt?.toISOString(),
    source: location.source,
  });
});

tripRouter.post("/:rideId/gps-ping", async (req: Request, res: Response) => {
  const rideId = req.params["rideId"] as string;
  const { driverId, lat, lng, recordedAt } = req.body;
  if (!driverId || lat == null || lng == null) {
    return res.status(400).json({ error: "driverId, lat, lng required" });
  }
  await recordPing(rideId, driverId, {
    lat,
    lng,
    recordedAt: recordedAt ? new Date(recordedAt) : new Date(),
  });
  return res.status(204).send();
});

tripRouter.post("/:rideId/gps-ping/bulk", async (req: Request, res: Response) => {
  const rideId = req.params["rideId"] as string;
  const { driverId, pings } = req.body;
  if (!driverId || !Array.isArray(pings) || pings.length === 0) {
    return res.status(400).json({ error: "driverId and pings[] required" });
  }
  const parsed = pings.map((p: { lat: number; lng: number; recordedAt: string }) => ({
    lat: p.lat,
    lng: p.lng,
    recordedAt: new Date(p.recordedAt),
  }));
  await recordBulkPings(rideId, driverId, parsed);
  return res.status(204).send();
});
