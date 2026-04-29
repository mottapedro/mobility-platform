import { Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";

/**
 * Test-only controller — only mounted when NODE_ENV !== "production".
 * Wipes all data in FK-safe order so each E2E scenario starts clean.
 */
export class TestController {
  async reset(_req: Request, res: Response) {
    await prisma.rideOffer.deleteMany();
    await prisma.rideRequest.deleteMany();
    await prisma.driverReferral.deleteMany();
    await prisma.driverAvailability.deleteMany();
    await prisma.driverRegion.deleteMany();
    await prisma.vehicle.deleteMany();
    await prisma.passenger.deleteMany();
    await prisma.driver.deleteMany();
    await prisma.user.deleteMany();

    return res.status(200).json({ ok: true });
  }
}
