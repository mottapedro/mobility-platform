import { Router } from "express";
import { DriverController } from "../controllers/driver.controller";
import { requireDriverAuth } from "../middleware/requireDriverAuth";
import { requireDriverBearerAuth } from "../middleware/requireDriverBearerAuth";

const router = Router();
const controller = new DriverController();

// POST /drivers (legado: se controller.create não existir, rota não é usada nos testes atuais)
router.post("/", (req, res) => res.status(410).json({ error: "Cadastro com referral deve usar POST /auth/register" }));


// GET /drivers
router.get("/", (req, res) => controller.list(req, res));

// Autenticação Bearer (Fase C): /drivers/me/* — sem x-driver-id
router.get("/me", requireDriverBearerAuth, (req, res) => controller.getMe(req, res));
router.get("/me/offers", requireDriverBearerAuth, (req, res) => controller.getMyOffers(req, res));
router.get("/me/rides", requireDriverBearerAuth, (req, res) => controller.getMyRides(req, res));
// Fase E — base operacional (origem M fixa) em self-service, Bearer only.
router.get("/me/operational-base", requireDriverBearerAuth, (req, res) => controller.getMyOperationalBase(req, res));
router.put("/me/operational-base", requireDriverBearerAuth, (req, res) => controller.upsertMyOperationalBase(req, res));

// GET /drivers/:driverId/network/hierarchy — driver + tree (must be registered before /:driverId/network)
router.get("/:driverId/network/hierarchy", (req, res) => controller.getNetworkHierarchy(req, res));

// V2: GET /drivers/:driverId/network/relationships — relational referral graph (must precede /:driverId/network)
router.get("/:driverId/network/relationships", (req, res) => controller.getNetworkRelationships(req, res));

// V2: GET /drivers/:driverId/skills — driver skill assignments
router.get("/:driverId/skills", (req, res) => controller.getDriverSkills(req, res));

// GET /drivers/:driverId/network — nós por nível + métricas de indicação (canônico)
router.get("/:driverId/network", (req, res) => controller.getNetwork(req, res));

// Compat: offers (autenticação é recomendada; mantido para legado)
router.get("/:driverId/offers", requireDriverAuth, (req, res) => controller.getOffers(req as any, res));

// Endpoint público canônico
router.get("/r/:slug", (req, res) => controller.resolvePublicReferral(req, res));


// GET /drivers/:driverId/rides  — corridas ACCEPTED do driver
router.get("/:driverId/rides", requireDriverBearerAuth, (req, res) => controller.listRides(req, res));

export { router as driverRoutes };
