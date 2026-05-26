import { Router } from "express";
import { AuthController } from "../controllers/auth.controller";

const router = Router();
const controller = new AuthController();

router.post("/register", (req, res) => controller.register(req, res));
router.post("/login", (req, res) => controller.login(req, res));
router.get("/login", (req, res) => {
  return res.status(405).json({
    error: "Method Not Allowed",
    message: "Use POST /auth/login instead of GET",
  });
});

export { router as authRoutes };
