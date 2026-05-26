import { Router } from "express";
import { DriverController } from "../controllers/driver.controller";

const router = Router();
const canonicalRouter = Router();
const controller = new DriverController();

router.get("/drivers/:referralCode", (req, res) => controller.getPublicProfile(req, res));
canonicalRouter.get("/r/:slug", (req, res) => controller.resolvePublicReferral(req, res));

export { router as publicRoutes };
export { canonicalRouter as canonicalPublicRoutes };
