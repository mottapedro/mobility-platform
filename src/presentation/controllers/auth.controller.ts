import { Request, Response } from "express";
import bcrypt from "bcrypt";
import { Prisma } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import { createDriverReferralChain, ReferralChainError } from "../../domain/services/DriverReferralService";

class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export class AuthController {
  async register(req: Request, res: Response) {
    try {
      const { name, email, password, role, phone, referralCode } = req.body;

      if (!name || !email || !password || !role || !phone) {
        return res
          .status(400)
          .json({ error: "Campos obrigatórios: name, email, password, role, phone" });
      }

      if (role !== "passenger" && role !== "driver") {
        return res.status(400).json({ error: "role deve ser 'passenger' ou 'driver'" });
      }

      const roleMap: Record<string, "DRIVER" | "PASSENGER"> = {
        driver: "DRIVER",
        passenger: "PASSENGER",
      };
      const prismaRole = roleMap[role];

      if (typeof password !== "string" || password.length < 6) {
        return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres" });
      }

      // onboarding referral deve ser via referralCode (campo público canônico)
      if ("referredByDriverId" in req.body) {
        return res.status(400).json({
          error: "Use apenas referralCode para cadastro com indicação",
        });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const payload = await prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({ where: { email } });
        if (existing) {
          throw new HttpError(409, "Este email já está cadastrado");
        }

        let referrerDriverId: string | null = null;

        if (referralCode !== undefined && referralCode !== null) {
          if (typeof referralCode !== "string" || !referralCode.trim()) {
            throw new HttpError(400, "referralCode deve ser string não vazia");
          }

          const driver = await tx.driver.findUnique({
            where: { referralCode: referralCode.trim() },
            select: { id: true, isActive: true },
          });

          if (!driver || !driver.isActive) {
            throw new HttpError(400, "Código de referral inválido ou motorista inativo");
          }

          referrerDriverId = driver.id;
        }

        if (role === "driver") {
          const user = await tx.user.create({
            data: { name, email, phone, role: prismaRole, passwordHash },
          });

          const driver = await tx.driver.create({
  data: {
    userId: user.id,
    isActive: true,
    experienceLevel: "INICIANTE",

    referredByDriverId: referrerDriverId,
  },
});

          if (referrerDriverId) {
            await createDriverReferralChain(driver.id, referrerDriverId, tx);
          }

          return {
            user: { id: user.id, name: user.name, email: user.email, role: "driver" },
            driverId: driver.id,
            referralCode: driver.referralCode,
          };
        }

        const user = await tx.user.create({
          data: { name, email, phone, role: prismaRole, passwordHash },
        });

        const passenger = await tx.passenger.create({
          data: {
            user: { connect: { id: user.id } },
            ...(referrerDriverId
              ? { referredByDriver: { connect: { id: referrerDriverId } } }
              : {}),
          },
          include: { user: true },
        });

        return {
          user: { id: user.id, name: user.name, email: user.email, role: "passenger" },
          passengerId: passenger.id,
          referredByDriverId: passenger.referredByDriverId ?? null,
        };
      });

      return res.status(201).json(payload);
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        return res.status(error.statusCode).json({ error: error.message });
      }

      if (error instanceof ReferralChainError) {
        return res.status(400).json({ error: error.message });
      }

      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return res.status(409).json({ error: "Este email já está cadastrado" });
      }

      console.error("🔥 Erro no registro:", error);
      return res.status(500).json({ error: "Erro interno ao registrar usuário" });
    }
  }

  async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: "Missing credentials" });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: "Email ou senha incorretos" });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: "Email ou senha incorretos" });
      }

      const role = user.role === "DRIVER" ? "driver" : "passenger";

      if (role === "driver") {
        const driver = await prisma.driver.findUnique({
          where: { userId: user.id },
          select: {
            id: true,
            referralCode: true,
            publicSlug: true,
            networkLevel: true,
            referredByDriverId: true,
            isActive: true,
          },
        });

        if (!driver) {
          return res.status(404).json({ error: "Driver não encontrado" });
        }

        return res.status(200).json({
          user: { id: user.id, name: user.name, email: user.email, role },
          driverId: driver.id,
          referralCode: driver.referralCode,
          publicSlug: driver.publicSlug ?? null,
          networkLevel: driver.networkLevel ?? 0,
          referredByDriverId: driver.referredByDriverId ?? null,
        });
      }

      const passenger = await prisma.passenger.findUnique({
        where: { userId: user.id },
        select: {
          id: true,
          referredByDriverId: true,
        },
      });

      if (!passenger) {
        return res.status(404).json({ error: "Passenger não encontrado" });
      }

      return res.status(200).json({
        user: { id: user.id, name: user.name, email: user.email, role },
        passengerId: passenger.id,
        referredByDriverId: passenger.referredByDriverId ?? null,
      });
    } catch (error) {
      console.error("🔥 Erro no login:", error);
      return res.status(500).json({ error: "Erro interno ao fazer login" });
    }
  }
}

