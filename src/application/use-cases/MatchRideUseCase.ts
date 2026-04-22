import { prisma } from "../../infra/prisma/client";

//const prisma = new PrismaClient();

export class MatchRideUseCase {

  async execute(rideRequestId: string) {

    // 1. Buscar corrida
    const ride = await prisma.rideRequest.findUnique({
      where: { id: rideRequestId },
      include: { passenger: true }
    });

    if (!ride) throw new Error("Ride not found");

    // 2. Atualizar status
    await prisma.rideRequest.update({
      where: { id: ride.id },
      data: { status: "MATCHING" }
    });

    // 3. Buscar motoristas elegíveis (simples por enquanto)
    const drivers = await prisma.driver.findMany({
      where: { isActive: true },
      take: 10
    });

    // 4. Ordenar (placeholder futuro: score)
    for (const driver of drivers) {

      // 5. Criar oferta
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000);

      await prisma.rideOffer.create({
        data: {
          rideRequestId: ride.id,
          driverId: driver.id,
          expiresAt
        }
      });

      console.log(`Offer enviada para driver ${driver.id}`);

      // 🔥 IMPORTANTE: parar no primeiro (fila)
      break;
    }
  }
}