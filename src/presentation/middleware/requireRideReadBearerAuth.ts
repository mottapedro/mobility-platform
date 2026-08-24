import { NextFunction, Request, Response } from "express";
import { AuthTokenService } from "../../domain/auth/AuthTokenService";
import { prisma } from "../../infra/prisma/client";

export interface AuthenticatedRideReadRequest extends Request {
  authUserId?: string;
  authPassengerId?: string;
  authDriverId?: string;
}

const tokenService = new AuthTokenService();

/**
 * Authenticates the actor allowed to read a ride detail.
 * Identity always comes from the revocable Bearer session; client supplied
 * driverId/passengerId values are deliberately ignored.
 */
export async function requireRideReadBearerAuth(
  req: AuthenticatedRideReadRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const header = req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    let verified: { sub: string; sid: string };
    try {
      verified = await tokenService.verifyAccessToken(token);
    } catch {
      return res.status(401).json({ error: "Authentication required" });
    }

    const session = await prisma.authSession.findUnique({
      where: { id: verified.sid },
      select: { userId: true, rotatedAt: true, revokedAt: true, expiresAt: true },
    });
    const active =
      session !== null &&
      session.userId === verified.sub &&
      session.rotatedAt === null &&
      session.revokedAt === null &&
      session.expiresAt.getTime() > Date.now();
    if (!active) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const user = await prisma.user.findUnique({
      where: { id: verified.sub },
      select: {
        role: true,
        passenger: { select: { id: true } },
        driver: { select: { id: true, isActive: true } },
      },
    });

    if (user?.role === "PASSENGER" && user.passenger) {
      req.authUserId = verified.sub;
      req.authPassengerId = user.passenger.id;
      return next();
    }

    if (user?.role === "DRIVER" && user.driver?.isActive) {
      req.authUserId = verified.sub;
      req.authDriverId = user.driver.id;
      return next();
    }

    return res.status(401).json({ error: "Authentication required" });
  } catch (error) {
    console.error("Erro ao autenticar leitor da corrida (Bearer):", error);
    return res.status(500).json({ error: "Erro interno ao autenticar" });
  }
}
