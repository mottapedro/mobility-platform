import { Router } from "express";
import { PaymentController } from "../controllers/payment.controller";
import { GeneratePaymentIntentController } from "../../domain/payment/GeneratePaymentIntentController";

const controller = new PaymentController();
const generateIntentController = new GeneratePaymentIntentController();

const ridesPaymentRouter = Router();
ridesPaymentRouter.post("/:id/payment-intent", (req, res) => controller.createIntent(req, res));
ridesPaymentRouter.post("/:id/payment-intent/generate", (req, res) => generateIntentController.generate(req, res));
ridesPaymentRouter.get("/:id/settlement", (req, res) => controller.getSettlement(req, res));

const pixWebhookRouter = Router();
pixWebhookRouter.post("/pix", (req, res) => controller.pixWebhook(req, res));

export { ridesPaymentRouter, pixWebhookRouter };
