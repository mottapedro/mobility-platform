import { Router } from "express";
import { prisma } from "../../infra/prisma/client";
import {
  createDriverReferralChain,
  getDriverNetwork,
} from "../../application/use-cases/CreateDriverService";

const router = Router();

// POST /drivers — create a new driver, optionally with a referrer
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

    // Validate referredByDriverId if provided
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

    // Build referral chain if a referrer was provided
    if (referredByDriverId && user.driver) {
      await createDriverReferralChain(user.driver.id, referredByDriverId);
    }

    console.log(`✅ Driver criado: ${user.driver?.id} (referredBy: ${referredByDriverId ?? "none"})`);

    return res.status(201).json({ user, driver: user.driver });
  } catch (error) {
    console.error("🔥 Erro ao criar driver:", error);
    return res.status(500).json({
      error: "Erro ao criar driver",
      details: error instanceof Error ? error.message : error,
    });
  }
});

// GET /drivers/:id/network — retrieve multi-level referral network for a driver
router.get("/:id/network", async (req, res) => {
  try {
    const { id } = req.params;

    const driver = await prisma.driver.findUnique({ where: { id } });
    if (!driver) {
      return res.status(404).json({ error: "Driver não encontrado" });
    }

    const network = await getDriverNetwork(id);

    return res.status(200).json({ driverId: id, network });
  } catch (error) {
    console.error("🔥 Erro ao buscar rede de indicação:", error);
    return res.status(500).json({
      error: "Erro ao buscar rede de indicação",
      details: error instanceof Error ? error.message : error,
    });
  }
});

export { router as driverRoutes };
