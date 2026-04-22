import { prisma } from "../../infra/prisma/client";

export class ExpireOffersService {
  async execute(): Promise<void> {
    const now = new Date();

    const expiredOffers = await prisma.rideOffer.findMany({
      where: {
        status: "PENDING",
        expiresAt: { lt: now },
      },
      select: { id: true, rideRequestId: true },
    });

    if (expiredOffers.length === 0) return;

    const offerIds = expiredOffers.map((o) => o.id);
    const rideIds = [...new Set(expiredOffers.map((o) => o.rideRequestId))];

    await prisma.rideOffer.updateMany({
      where: { id: { in: offerIds } },
      data: { status: "EXPIRED" },
    });

    console.log(`⏱️ ${offerIds.length} offer(s) expirada(s)`);

    // 🔥 versão otimizada
    const ridesWithActiveOffers = await prisma.rideOffer.groupBy({
      by: ["rideRequestId"],
      where: {
        rideRequestId: { in: rideIds },
        status: { notIn: ["EXPIRED", "REJECTED"] },
      },
      _count: true,
    });

    const activeRideSet = new Set(
      ridesWithActiveOffers.map((r) => r.rideRequestId)
    );

    const ridesToExpire = rideIds.filter((id) => !activeRideSet.has(id));

    if (ridesToExpire.length > 0) {
      await prisma.rideRequest.updateMany({
        where: {
          id: { in: ridesToExpire },
          status: { in: ["PENDING", "MATCHING", "WAITING_DRIVER"] },
        },
        data: { status: "EXPIRED" },
      });

      console.log(`❌ ${ridesToExpire.length} corrida(s) expirada(s)`);
    }
  }
}