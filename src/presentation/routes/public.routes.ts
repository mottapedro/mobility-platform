import { Router } from "express";
import { DriverController } from "../controllers/driver.controller";

const router = Router();
const controller = new DriverController();

router.get("/drivers/:referralCode", (req, res) => controller.getPublicProfile(req, res));

export { router as publicRoutes };