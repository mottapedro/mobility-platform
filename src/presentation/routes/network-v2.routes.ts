import { Router } from "express";
import { NetworkV2Controller } from "../controllers/network-v2.controller";

export const onboardingRouter = Router();
onboardingRouter.get("/context/:slug", NetworkV2Controller.getOnboardingContext);

export const passengersNetworkRouter = Router();
passengersNetworkRouter.get("/:id/lineage", NetworkV2Controller.getPassengerLineage);

export const driversNetworkRouter = Router();
driversNetworkRouter.get("/:id/ownership", NetworkV2Controller.getDriverOwnership);
driversNetworkRouter.get("/:id/network/summary", NetworkV2Controller.getDriverNetwork);
driversNetworkRouter.get("/:id/network/tree", NetworkV2Controller.getGenealogyTree);

/** /network/context?actorId=&actorType= — operational network context for any actor. */
export const networkLegacyRouter = Router();
networkLegacyRouter.get("/context", NetworkV2Controller.getNetworkContext);
