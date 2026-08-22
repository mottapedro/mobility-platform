import { NextFunction, Request, Response } from "express";
import { AuthTokenService } from "../../domain/auth/AuthTokenService";
import { prisma } from "../../infra/prisma/client";

export interface AuthenticatedPassengerRequest extends Request {
  authPassengerId?: string;
  authUserId?: string;
}

const tokenService = new AuthTokenService();

/** Authenticate a passenger from the revocable Bearer session, never from a body or route id. */
export async function requirePassengerBearerAuth(
  req: AuthenticatedPassengerRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const header = req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Passenger authentication required" });
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      return res.status(401).json({ error: "Passenger authentication required" });
    }

    let verified: { sub: string; sid: string };
    try {
      verified = await tokenService.verifyAccessToken(token);
    } catch {
      return res.status(401).json({ error: "Passenger authentication required" });
    }

    const session = await prisma.authSession.findUnique({
      where: { id: verified.sid },
      select: {
        userId: true,
        rotatedAt: true,
        revokedAt: true,
        expiresAt: true,
      },
    });
    const active =
      session !== null &&
      session.userId === verified.sub &&
      session.rotatedAt === null &&
      session.revokedAt === null &&
      session.expiresAt.getTime() > Date.now();
    if (!active) {
      return res.status(401).json({ error: "Passenger authentication required" });
    }

    const passenger = await prisma.passenger.findFirst({
      where: { userId: verified.sub },
      select: { id: true },
    });
    if (!passenger) {
      return res.status(401).json({ error: "Passenger authentication required" });
    }

    req.authPassengerId = passenger.id;
    req.authUserId = verified.sub;
    return next();
  } catch (error) {
    console.error("Erro ao autenticar passageiro (Bearer):", error);
    return res.status(500).json({ error: "Erro interno ao autenticar passageiro" });
  }
}
