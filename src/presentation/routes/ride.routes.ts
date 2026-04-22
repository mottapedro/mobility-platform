import { Router } from "express";
import { RideController } from "../controllers/ride.controller";
import { prisma } from "../../infra/prisma/client";

console.log("🔥 PRISMA:", prisma);
console.log("🔥 PRISMA.PASSENGER:", prisma?.passenger);

const router = Router();
const controller = new RideController();

router.post("/passengers", async (req, res) => {
  try {
    console.log("🔥 BODY PASSENGER:", req.body);

    const { name, email, phone } = req.body;

    if (!name || !email || !phone) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const passenger = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name,
            email,
            phone,
            role: "PASSENGER",
          },
        },
      },
      include: {
        user: true,
      },
    });

    console.log("🔥 PASSENGER CREATED:", passenger);

    return res.status(201).json(passenger);
  } catch (error) {
    console.error("🔥 ERRO REAL PASSENGER:", error);

    return res.status(500).json({
      error: "Erro ao criar passageiro",
      details: error instanceof Error ? error.message : error,
    });
  }
});

router.post("/", (req, res) => controller.create(req, res));
router.get("/:id", (req, res) => controller.getById(req, res));

export { router as rideRoutes };