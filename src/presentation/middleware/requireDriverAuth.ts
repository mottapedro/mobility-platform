import { NextFunction, Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";

export interface AuthenticatedDriverRequest extends Request {
  authDriverId?: string;
}

export async function requireDriverAuth(
  req: AuthenticatedDriverRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const driverId = req.header("x-driver-id");

    if (!driverId || typeof driverId !== "string") {
      return res.status(401).json({ error: "Driver authentication required" });
    }

    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { id: true, isActive: true },
    });

    if (!driver || !driver.isActive) {
      return res.status(401).json({ error: "Driver authentication required" });
    }

    req.authDriverId = driver.id;
    next();
  } catch (error) {
    console.error("Erro ao autenticar motorista:", error);
    return res.status(500).json({ error: "Erro interno ao autenticar motorista" });
  }
}