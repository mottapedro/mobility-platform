import { Router } from "express";
import { AuthController } from "../controllers/auth.controller";

const router = Router();
const controller = new AuthController();

router.post("/login", (req, res) => controller.login(req, res));
router.post("/register", (req, res) => controller.register(req, res));

export { router as authRoutes };
