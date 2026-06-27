import { Router } from "express";
import { PicPayWebhookController } from "../controllers/PicPayWebhookController";

const controller = new PicPayWebhookController();

const router = Router();

router.post("/picpay", (req, res) => controller.handle(req, res));

export { router as picpayWebhookRouter };