import { Request, Response } from "express";
import { prisma } from "../../infra/prisma/client";
import { PaymentStatus } from "../../shared/enums";

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
    await prisma.vehicle.deleteMany();
    await prisma.passenger.deleteMany();
    await prisma.driver.deleteMany();
    await prisma.user.deleteMany();

    return res.status(200).json({ ok: true });
  }

  async confirmPayment(req: Request, res: Response) {
    const { rideId } = req.body as { rideId?: string };

    const amountCents =
      typeof req.body.amountCents === "number" && Number.isInteger(req.body.amountCents) && req.body.amountCents > 0
        ? req.body.amountCents
        : 1000;

    if (!rideId) {
      return res.status(400).json({ error: "rideId is required" });
    }

    const intent = await prisma.paymentIntent.upsert({
      where: { rideRequestId: rideId },
      create: {
        rideRequestId: rideId,
        amountCents,
        method: "PIX",
        status: PaymentStatus.CONFIRMED,
        qrCode: `MOCK-CONFIRMED-${Date.now()}`,
        qrCodeImage: "https://mock.pix.confirmed/image.png",
        externalId: `mock-confirmed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
      update: {
        amountCents,
        status: PaymentStatus.CONFIRMED,
        confirmedAt: new Date(),
      },
    });

    return res.status(201).json({ id: intent.id, status: intent.status, externalId: intent.externalId });
  }
}
