import { Router } from "express";
import { RideLifecycleController } from "../controllers/ride-lifecycle.controller";

export const rideLifecycleRouter = Router();

rideLifecycleRouter.post("/:id/lifecycle/start", RideLifecycleController.start);
rideLifecycleRouter.post("/:id/lifecycle/progress", RideLifecycleController.progress);
rideLifecycleRouter.post("/:id/lifecycle/complete", RideLifecycleController.complete);
rideLifecycleRouter.post("/:id/lifecycle/cancel", RideLifecycleController.cancelRide);
