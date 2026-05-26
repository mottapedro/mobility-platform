import { Router } from "express";
import { GodNetworkController } from "../controllers/godnetwork.controller";

const router = Router();
const controller = new GodNetworkController();

// GET /godnetwork/status — conformance report against the locked official structure
router.get("/status", (req, res) => controller.getStatus(req, res));

export { router as godnetworkRoutes };
