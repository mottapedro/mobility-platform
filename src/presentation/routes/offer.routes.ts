import { Router } from "express";
import { OfferController } from "../controllers/offer.controller";

const router = Router();
const controller = new OfferController();

// PATCH /offers/:offerId/respond  →  { accept: true | false }
router.patch("/:offerId/respond", (req, res) => controller.respond(req, res));

export { router as offerRoutes };
