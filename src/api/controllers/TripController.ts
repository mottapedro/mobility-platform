import { Router, Request, Response } from "express";
import { recordPing, recordBulkPings } from "../../domain/trip/TripTrackingService";

export const tripRouter = Router();

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
