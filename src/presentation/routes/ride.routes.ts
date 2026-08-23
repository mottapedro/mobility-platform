import { Router } from "express";
import { randomBytes } from "crypto";
import { RideController } from "../controllers/ride.controller";
import { prisma } from "../../infra/prisma/client";
import { assignPassengerIdentity } from "../../domain/services/PassengerReferralService";
import { recordPassengerReferralRelationship } from "../../domain/referral-network/ReferralRelationshipService";
import { PUBLIC_USER_SELECT } from "../../shared/http/userPublic";

const router = Router();
const controller = new RideController();
const asExtendedTx = (tx: any): typeof prisma => tx as typeof prisma;

router.patch("/:id/reschedule", async (req, res) => controller.reschedule(req, res));
router.post("/:id/start", async (req, res) => controller.start(req, res));
router.post("/:id/complete", async (req, res) => controller.complete(req, res));

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
        include: { user: { select: PUBLIC_USER_SELECT } },
      });

      if (existingPassenger) {
        return res.status(200).json(existingPassenger);
      }
    }

    const tmpSlug = `p-${randomBytes(8).toString("hex")}`;

    const updated = await prisma.$transaction(async (tx) => {
      const passenger = await tx.passenger.create({
        data: {
          referralCode: tmpSlug,
          publicSlug: tmpSlug,
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

      await recordPassengerReferralRelationship(
        passenger.id,
        { referredByDriverId },
        asExtendedTx(tx)
      );
      await assignPassengerIdentity(passenger.id, name, asExtendedTx(tx));

      return tx.passenger.findUniqueOrThrow({
        where: { id: passenger.id },
        include: { user: { select: PUBLIC_USER_SELECT } },
      });
    });

    return res.status(201).json(updated);
  } catch (error) {
    console.error("🔥 ERRO REAL PASSENGER:", error);

    return res.status(500).json({
      error: "Erro ao criar passageiro",
      details: error instanceof Error ? error.message : error,
    });
  }
});

router.post("/", (req, res) => controller.create(req, res));
router.post("/:id/confirm-quote", (req, res) => controller.confirmQuote(req, res));
router.patch("/:id", (req, res) => controller.patch(req, res));
router.get("/:id", (req, res) => controller.getById(req, res));

export { router as rideRoutes };
