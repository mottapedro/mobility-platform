import { Router } from "express";
import { PassengerController } from "../controllers/passenger.controller";

const router = Router();
const controller = new PassengerController();

// POST /passengers
router.post("/", (req, res) => controller.create(req, res));

// Specific routes MUST come before /:id to avoid /:id consuming "network" as an id
router.get("/:id/network/hierarchy", (req, res) => controller.getHierarchy(req, res));
router.get("/:id/network", (req, res) => controller.getNetwork(req, res));

// GET /passengers/:id
router.get("/:id", (req, res) => controller.getById(req, res));

export { router as passengerRoutes };
