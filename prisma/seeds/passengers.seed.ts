import { PrismaClient } from "@prisma/client";

export async function seedPassengers(prisma: PrismaClient) {
  const passengerUsers = await prisma.user.findMany({ where: { role: "PASSENGER" } });

  for (const user of passengerUsers) {
    await prisma.passenger.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id },
    });
  }

  console.log(`✅ Passengers criados (${passengerUsers.length})`);
}
