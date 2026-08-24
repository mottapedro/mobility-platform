import { Router } from "express";
import { OfferController } from "../controllers/offer.controller";
import { requireDriverBearerAuth } from "../middleware/requireDriverBearerAuth";

const router = Router();
const controller = new OfferController();

// PATCH /offers/:offerId/respond  →  { accept: true | false }
router.patch("/:offerId/respond", requireDriverBearerAuth, (req, res) => controller.respond(req, res));

export { router as offerRoutes };
