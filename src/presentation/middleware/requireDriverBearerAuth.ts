import { NextFunction, Response } from "express";
import { AuthTokenService } from "../../domain/auth/AuthTokenService";
import { prisma } from "../../infra/prisma/client";
import { AuthenticatedDriverRequest } from "./requireDriverAuth";

const tokenService = new AuthTokenService();

export async function requireDriverBearerAuth(
  req: AuthenticatedDriverRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const header = req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Driver authentication required" });
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      return res.status(401).json({ error: "Driver authentication required" });
    }

    let verified: {
      sub: string;
      sid: string;
    };
    try {
      verified = await tokenService.verifyAccessToken(token);
    } catch {
      return res.status(401).json({ error: "Driver authentication required" });
    }

    const session = await prisma.authSession.findUnique({
      where: { id: verified.sid },
      select: {
        id: true,
        userId: true,
        rotatedAt: true,
        revokedAt: true,
        expiresAt: true,
      },
    });

    const sessionActive =
      session !== null &&
      session.userId === verified.sub &&
      session.rotatedAt === null &&
      session.revokedAt === null &&
      session.expiresAt.getTime() > Date.now();

    if (!sessionActive) {
      return res.status(401).json({ error: "Driver authentication required" });
    }

    const driver = await prisma.driver.findFirst({
      where: { userId: verified.sub, isActive: true },
      select: { id: true },
    });

    if (!driver) {
      return res.status(401).json({ error: "Driver authentication required" });
    }

    req.authDriverId = driver.id;
    next();
  } catch (error) {
    console.error("Erro ao autenticar motorista (Bearer):", error);
    return res.status(500).json({ error: "Erro interno ao autenticar motorista" });
  }
}