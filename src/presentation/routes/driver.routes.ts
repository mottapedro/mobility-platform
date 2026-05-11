import { Router } from "express";
import { DriverController } from "../controllers/driver.controller";

const router = Router();
const controller = new DriverController();

// POST /drivers
router.post("/", (req, res) => controller.create(req, res));

// GET /drivers
router.get("/", (req, res) => controller.list(req, res));

// GET /drivers/:id/offers  — offers PENDING visíveis para o driver
router.get("/:id/offers", (req, res) => controller.getOffers(req, res));

// GET /drivers/:driverId/rides  — corridas ACCEPTED do driver
router.get("/:driverId/rides", (req, res) => controller.listRides(req, res));

export { router as driverRoutes };
