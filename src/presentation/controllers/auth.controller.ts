import { Request, Response } from "express";
import bcrypt from "bcrypt";
import { prisma } from "../../infra/prisma/client";
import { createDriverReferralChain } from "../../domain/services/DriverReferralService";

export class AuthController {
  async register(req: Request, res: Response) {
    try {
      const { name, email, password, role, phone, referredByDriverId } = req.body;

      if (!name || !email || !password || !role || !phone) {
        return res.status(400).json({
          error: "Campos obrigatórios: name, email, password, role, phone",
        });
      }

      if (role !== "passenger" && role !== "driver") {
        return res.status(400).json({ error: "role deve ser 'passenger' ou 'driver'" });
      }

      const roleMap: Record<string, "DRIVER" | "PASSENGER"> = {
        driver: "DRIVER",
        passenger: "PASSENGER",
      };
      const prismaRole = roleMap[role];

      if (password.length < 6) {
        return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres" });
      }

      // Check unique email
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(400).json({ error: "Este email já está cadastrado" });
      }

      // Validate referral driver (for both passenger and driver registration)
      if (referredByDriverId) {
        const driver = await prisma.driver.findUnique({ where: { id: referredByDriverId } });
        if (!driver || !driver.isActive) {
          return res.status(400).json({ error: "Motorista indicado não encontrado ou inativo" });
        }
      }

      const passwordHash = await bcrypt.hash(password, 10);

      if (role === "driver") {
        const user = await prisma.user.create({
          data: { name, email, phone, role: prismaRole, passwordHash },
        });
        const driver = await prisma.driver.create({
          data: { userId: user.id, isActive: true, experienceLevel: "INICIANTE" },
        });
        // Create referral chain if driver was referred by another driver
        if (referredByDriverId) {
          await createDriverReferralChain(driver.id, referredByDriverId);
        }
        return res.status(201).json({
          user: { id: user.id, name: user.name, email: user.email, role: "driver" },
          driverId: driver.id,
        });
      }

      // passenger
      const user = await prisma.user.create({
        data: { name, email, phone, role: prismaRole, passwordHash },
      });
      const passenger = await prisma.passenger.create({
        data: {
          user: { connect: { id: user.id } },
          ...(referredByDriverId
            ? { referredByDriver: { connect: { id: referredByDriverId } } }
            : {}),
        },
        include: { user: true },
      });

      return res.status(201).json({
        user: { id: user.id, name: user.name, email: user.email, role: "passenger" },
        passengerId: passenger.id,
        referredByDriverId: passenger.referredByDriverId ?? null,
      });
    } catch (error: unknown) {
      console.error("🔥 Erro no registro:", error);
      return res.status(500).json({ error: "Erro interno ao registrar usuário" });
    }
  }

  async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: "Campos obrigatórios: email, password" });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash) {
        console.log(`[login] ❌ Usuário não encontrado ou sem hash: ${email} | found=${!!user} | hasHash=${!!user?.passwordHash}`);
        return res.status(401).json({ error: "Email ou senha incorretos" });
      }

      console.log(`[login] 🔍 Tentativa: ${email} | hashPrefix=${user.passwordHash.substring(0, 7)}`);
      const valid = await bcrypt.compare(password, user.passwordHash);
      console.log(`[login] ${valid ? "✅ Senha válida" : "❌ Senha inválida"}: ${email}`);
      if (!valid) {
        return res.status(401).json({ error: "Email ou senha incorretos" });
      }

      const role = user.role === "DRIVER" ? "driver" : "passenger";
      let entityId: string | undefined;

      if (role === "driver") {
        const driver = await prisma.driver.findUnique({ where: { userId: user.id } });
        entityId = driver?.id;
      } else {
        const passenger = await prisma.passenger.findUnique({ where: { userId: user.id } });
        entityId = passenger?.id;
        return res.status(200).json({
          user: { id: user.id, name: user.name, email: user.email, role },
          passengerId: entityId,
          referredByDriverId: passenger?.referredByDriverId ?? null,
        });
      }

      return res.status(200).json({
        user: { id: user.id, name: user.name, email: user.email, role },
        driverId: entityId,
      });
    } catch (error) {
      console.error("🔥 Erro no login:", error);
      return res.status(500).json({ error: "Erro interno ao fazer login" });
    }
  }
}
