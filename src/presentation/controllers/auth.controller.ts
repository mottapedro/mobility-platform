import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../infra/prisma/client";

export class AuthController {
  async login(req: Request, res: Response) {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email e senha são obrigatórios" });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        driver: { select: { id: true } },
        passenger: { select: { id: true } },
      },
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "Email ou senha incorretos" });
    }

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);

    if (!passwordMatch) {
      return res.status(401).json({ error: "Email ou senha incorretos" });
    }

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      driverId: user.driver?.id ?? null,
      passengerId: user.passenger?.id ?? null,
    });
  }

  async register(req: Request, res: Response) {
    const { name, email, password, phone, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: "Campos obrigatórios: name, email, password, role" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: "Email já cadastrado" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        phone: phone ?? "",
        passwordHash,
        role,
      },
      select: { id: true, name: true, email: true, role: true },
    });

    return res.status(201).json({ user });
  }
}
