import { Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";
import { createEventBus } from "../../domain/shared/events/EventBus";
import { start, cancel } from "../../domain/ride-execution/RideExecutionService";
import { execute as finalizeRide } from "../../application/services/FinalizeRideService";
import { RideLifecycleError } from "../../domain/ride-execution/RideLifecycleError";

function paramId(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? String(v[0]) : String(v);
}

export class RideLifecycleController {
  static async start(req: Request, res: Response) {
    const id = paramId(req, "id");
    try {
      const result = await start(id);
      return res.json({ rideId: id, status: result.ride.status, started: result.started });
    } catch (err) {
      if (err instanceof RideLifecycleError) {
        return res.status(422).json({ error: err.message });
      }
      throw err;
    }
  }

  static async progress(req: Request, res: Response) {
    const id = paramId(req, "id");
    const ride = await prisma.rideRequest.findUnique({ where: { id } });
    if (!ride) return res.status(404).json({ error: `Ride ${id} not found` });
    return res.json({ rideId: id, status: ride.status });
  }

  static async complete(req: Request, res: Response) {
    const id = paramId(req, "id");
    const bus = createEventBus();
    try {
      const result = await finalizeRide({ rideRequestId: id }, { bus });
      return res.json({ rideId: id, status: result.ride.status, finalized: result.finalized });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(msg) || /RideLifecycle:/i.test(msg)) {
        return res.status(422).json({ error: msg });
      }
      throw err;
    }
  }

  static async cancelRide(req: Request, res: Response) {
    const id = paramId(req, "id");
    try {
      const result = await cancel(id);
      return res.json({ rideId: id, status: result.ride.status, cancelled: result.cancelled });
    } catch (err) {
      if (err instanceof RideLifecycleError) {
        return res.status(422).json({ error: err.message });
      }
      throw err;
    }
  }
}
