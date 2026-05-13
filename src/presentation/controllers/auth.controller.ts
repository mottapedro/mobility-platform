import { Request, Response } from "express";
import bcrypt from "bcrypt";
import { prisma } from "../../infra/prisma/client";
import { createDriverReferralChain } from "../../domain/services/DriverReferralService";
import { resolveReferralCodeToDriverId } from "../../domain/services/ReferralCodeService";
import { buildDriverPublicSlug } from "../../domain/services/DriverIdentityService";

export class AuthController {
  async register(req: Request, res: Response) {
    try {
      const { name, email, password, role, phone, referredByDriverId, referralCode } = req.body;

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

      let resolvedReferralDriverId: string | null = typeof referredByDriverId === "string" ? referredByDriverId : null;

      if (typeof referralCode === "string" && referralCode.trim()) {
        resolvedReferralDriverId = await resolveReferralCodeToDriverId(referralCode);

        if (!resolvedReferralDriverId) {
          return res.status(400).json({ error: "Referral code inválido ou expirado" });
        }
      }

      // Validate referral driver (for both passenger and driver registration)
      if (resolvedReferralDriverId) {
        const driver = await prisma.driver.findUnique({ where: { id: resolvedReferralDriverId } });
        if (!driver || !driver.isActive) {
          return res.status(400).json({ error: "Motorista indicado não encontrado ou inativo" });
        }
      }

      const passwordHash = await bcrypt.hash(password, 10);

      if (role === "driver") {
        const referrer = resolvedReferralDriverId
          ? await prisma.driver.findUnique({
              where: { id: resolvedReferralDriverId },
              select: { id: true, networkLevel: true },
            })
          : null;

        const result = await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: { name, email, phone, role: prismaRole, passwordHash },
          });

          const publicSlug = buildDriverPublicSlug(name);
          const driver = await tx.driver.create({
            data: {
              userId: user.id,
              isActive: true,
              experienceLevel: "INICIANTE",
              referredByDriverId: resolvedReferralDriverId,
              networkLevel: referrer ? referrer.networkLevel + 1 : 0,
              publicSlug,
              referralCode: publicSlug,
            },
          });

          if (resolvedReferralDriverId) {
            await createDriverReferralChain(driver.id, resolvedReferralDriverId, tx as typeof prisma);
          }

          return { user, driver };
        });

        return res.status(201).json({
          user: { id: result.user.id, name: result.user.name, email: result.user.email, role: "driver" },
          driverId: result.driver.id,
        });
      }

      // passenger
      const user = await prisma.user.create({
        data: { name, email, phone, role: prismaRole, passwordHash },
      });
      const passenger = await prisma.passenger.create({
        data: {
          user: { connect: { id: user.id } },
          ...(resolvedReferralDriverId
            ? { referredByDriver: { connect: { id: resolvedReferralDriverId } } }
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

      console.log("[LOGIN REQUEST]", { method: req.method, email, hasPassword: !!password });

      if (!email || !password) {
        return res.status(400).json({ error: "Missing credentials" });
      }

      const users = await prisma.user.findMany();
      console.log("USERS IN DB:", users.map(u => u.email));

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash) {
        console.log("[LOGIN FAILED]", { email, reason: "User not found or missing hash" });
        return res.status(401).json({ error: "Email ou senha incorretos" });
      }

      console.log("[LOGIN]", { email: user.email, hashPrefix: user.passwordHash.substring(0, 7) });
      const valid = await bcrypt.compare(password, user.passwordHash);
      console.log("[LOGIN] password match:", valid);
      if (!valid) {
        console.log("[LOGIN FAILED]", { email, reason: "Invalid credentials" });
        return res.status(401).json({ error: "Email ou senha incorretos" });
      }

      const role = user.role === "DRIVER" ? "driver" : "passenger";
      let entityId: string | undefined;

      if (role === "driver") {
        const driver = await prisma.driver.findUnique({ where: { userId: user.id } });
        entityId = driver?.id;
        console.log("[LOGIN SUCCESS]", { email, driverId: entityId });
        return res.status(200).json({
          user: { id: user.id, name: user.name, email: user.email, role },
          driverId: entityId,
          referralCode: driver?.referralCode ?? null,
          publicSlug: driver?.publicSlug ?? null,
          networkLevel: driver?.networkLevel ?? 0,
          referredByDriverId: driver?.referredByDriverId ?? null,
        });
      } else {
        const passenger = await prisma.passenger.findUnique({ where: { userId: user.id } });
        entityId = passenger?.id;
        console.log("[LOGIN SUCCESS]", { email, passengerId: entityId });
        return res.status(200).json({
          user: { id: user.id, name: user.name, email: user.email, role },
          passengerId: entityId,
          referredByDriverId: passenger?.referredByDriverId ?? null,
        });
      }
    } catch (error) {
      console.error("🔥 Erro no login:", error);
      return res.status(500).json({ error: "Erro interno ao fazer login" });
    }
  }
}
