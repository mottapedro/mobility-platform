import { Router } from "express";
import { RideController } from "../controllers/ride.controller";
import { prisma } from "../../infra/prisma/client";

const router = Router();
const controller = new RideController();

router.post("/passengers", async (req, res) => {
  try {
    const { name, email, phone, referredByDriverId } = req.body;

    if (!name || !email || !phone) {
      return res.status(400).json({ error: "Missing fields", required: ["name", "email", "phone"] });
    }

    // Validar referredByDriverId se informado
    if (referredByDriverId !== undefined && referredByDriverId !== null) {
      if (typeof referredByDriverId !== "string") {
        return res.status(400).json({ error: "referredByDriverId deve ser string" });
      }

      const driverExists = await prisma.driver.findUnique({
        where: { id: referredByDriverId },
      });

      if (!driverExists) {
        return res.status(404).json({ error: "Driver indicado não encontrado", referredByDriverId });
      }
    }

    // Se o passageiro já existe, retornar o existente (mesmo usuário, múltiplas corridas)
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      const existingPassenger = await prisma.passenger.findUnique({
        where: { userId: existingUser.id },
        include: { user: true },
      });

      if (existingPassenger) {
        return res.status(200).json(existingPassenger);
      }
    }

    const passenger = await prisma.passenger.create({
      data: {
        ...(referredByDriverId
          ? { referredByDriver: { connect: { id: referredByDriverId } } }
          : {}),
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
router.patch("/:id", (req, res) => controller.patch(req, res));
router.get("/:id", (req, res) => controller.getById(req, res));

export { router as rideRoutes };