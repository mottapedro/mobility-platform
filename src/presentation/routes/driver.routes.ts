import { Router } from "express";
import { prisma } from "../../infra/prisma/client";
import { createDriverReferralChain } from "../../application/use-cases/DriverReferralService";

const router = Router();

// POST /drivers — create a new driver (with optional referral)
router.post("/", async (req, res) => {
  try {
    const { name, email, phone, experienceLevel, referredByDriverId } = req.body;

    if (!name || !email || !phone || !experienceLevel) {
      return res.status(400).json({
        error: "Missing fields",
        required: ["name", "email", "phone", "experienceLevel"],
      });
    }

    const validLevels = ["INICIANTE", "INTERMEDIARIO", "PROFISSIONAL", "ELITE"];
    if (!validLevels.includes(experienceLevel)) {
      return res.status(400).json({
        error: "Invalid experienceLevel",
        valid: validLevels,
      });
    }

    if (referredByDriverId !== undefined && referredByDriverId !== null) {
      if (typeof referredByDriverId !== "string") {
        return res.status(400).json({ error: "referredByDriverId deve ser string" });
      }

      const referrerExists = await prisma.driver.findUnique({
        where: { id: referredByDriverId },
      });

      if (!referrerExists) {
        return res.status(404).json({
          error: "Driver indicador não encontrado",
          referredByDriverId,
        });
      }
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ error: "E-mail já cadastrado" });
    }

    const user = await prisma.user.create({
      data: {
        name,
        email,
        phone,
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel,
            isActive: true,
            ...(referredByDriverId ? { referredByDriverId } : {}),
          },
        },
      },
      include: { driver: true },
    });

    // Build multi-level referral chain if the driver was referred
    if (referredByDriverId && user.driver?.id) {
      await createDriverReferralChain(user.driver.id, referredByDriverId);
    }

    return res.status(201).json({
      message: "Driver criado com sucesso",
      driver: {
        id: user.driver?.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        experienceLevel: user.driver?.experienceLevel,
        referredByDriverId: user.driver?.referredByDriverId,
      },
    });
  } catch (error) {
    console.error("🔥 Erro ao criar driver:", error);
    return res.status(500).json({
      error: "Erro ao criar driver",
      details: error instanceof Error ? error.message : error,
    });
  }
});

// GET /drivers/:id/network — return driver's referral network
router.get("/:id/network", async (req, res) => {
  try {
    const { id } = req.params;

    const driver = await prisma.driver.findUnique({ where: { id } });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    const { getDriverNetwork } = await import(
      "../../application/use-cases/DriverReferralService"
    );
    const network = await getDriverNetwork(id);

    return res.status(200).json({ driverId: id, network });
  } catch (error) {
    console.error("🔥 Erro ao buscar rede do driver:", error);
    return res.status(500).json({
      error: "Erro ao buscar rede do driver",
      details: error instanceof Error ? error.message : error,
    });
  }
});

export { router as driverRoutes };
