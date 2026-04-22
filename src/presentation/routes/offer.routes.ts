import { Router } from "express";
import { OfferController } from "../controllers/offer.controller";
import { prisma } from "../../infra/prisma/client";

const router = Router();
const controller = new OfferController(prisma);

router.post("/respond", (req, res) => controller.respond(req, res));

export { router as offerRoutes };