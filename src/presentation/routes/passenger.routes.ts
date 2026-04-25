import { Router } from "express";
import { PassengerController } from "../controllers/passenger.controller";

const router = Router();
const controller = new PassengerController();

// GET /passengers/:id
router.get("/:id", (req, res) => controller.getById(req, res));

export { router as passengerRoutes };
