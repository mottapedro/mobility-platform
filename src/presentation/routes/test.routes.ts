import { Router } from "express";
import { TestController } from "../controllers/test.controller";

const router = Router();
const ctrl = new TestController();

router.post("/reset", (req, res) => ctrl.reset(req, res));
router.post("/confirm-payment", (req, res) => ctrl.confirmPayment(req, res));

export { router as testRoutes };
