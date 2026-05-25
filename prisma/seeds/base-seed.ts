import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

export async function runBaseSeed(prisma: PrismaClient) {
  const passwordHash = await bcrypt.hash("123456", 10);

  const user = await prisma.user.upsert({
    where: { email: "ana.beatriz@mobility.com" },
    update: {
      name: "Ana Beatriz Santos",
      phone: "21999990009",
      role: "PASSENGER",
    },
    create: {
      name: "Ana Beatriz Santos",
      email: "ana.beatriz@mobility.com",
      phone: "21999990009",
      role: "PASSENGER",
      passwordHash,
    },
  });

  await prisma.passenger.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id },
  });
}

if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  runBaseSeed(prisma)
    .catch((error) => {
      console.error("Base seed failed", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
      await pool.end();
    });
}
