import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { runBaseSeed } from "./base-seed";
import { runBootstrapNetwork } from "./bootstrap-network";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export async function runDevFixtures() {
  await runBaseSeed(prisma);
  await runBootstrapNetwork(prisma);

  const passwordHash = await bcrypt.hash("123456", 10);
  const qaUser = await prisma.user.upsert({
    where: { email: "ana.claudia@email.com" },
    update: {
      name: "Ana Cláudia Elias",
      phone: "21974771788",
      role: "PASSENGER",
    },
    create: {
      name: "Ana Cláudia Elias",
      email: "ana.claudia@email.com",
      phone: "21974771788",
      role: "PASSENGER",
      passwordHash,
    },
  });

  await prisma.passenger.upsert({
    where: { userId: qaUser.id },
    update: {},
    create: { userId: qaUser.id },
  });
}

export async function closeDevFixturesResources() {
  await prisma.$disconnect();
  await pool.end();
}

if (require.main === module) {
  runDevFixtures()
    .catch((error) => {
      console.error("Dev fixtures failed", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDevFixturesResources();
    });
}
