import { Router } from "express";
import { NetworkV2Controller } from "../controllers/network-v2.controller";

export const onboardingRouter = Router();
onboardingRouter.get("/context/:slug", NetworkV2Controller.getOnboardingContext);

export const passengersNetworkRouter = Router();
passengersNetworkRouter.get("/:id/lineage", NetworkV2Controller.getPassengerLineage);

export const driversNetworkRouter = Router();
driversNetworkRouter.get("/:id/ownership", NetworkV2Controller.getDriverOwnership);
driversNetworkRouter.get("/:id/network/summary", NetworkV2Controller.getDriverNetwork);

/** Legacy route — was called by older frontend builds; now 410 Gone. */
export const networkLegacyRouter = Router();
networkLegacyRouter.get("/context", (_req, res) =>
  res.status(410).json({ error: "Deprecated. Use GET /onboarding/context/:slug" })
);
