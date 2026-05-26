import { Router } from "express";
import { GenealogyController } from "../controllers/genealogy.controller";

/**
 * Mounted at /drivers — consistent with driversNetworkRouter.
 *
 * GET /drivers/:id/network/genealogy           — full tree, default maxDepth=5
 * GET /drivers/:id/network/genealogy?maxDepth=N — capped at 10
 */
export const genealogyRouter = Router();
genealogyRouter.get("/:id/network/genealogy", GenealogyController.getDriverGenealogy);
