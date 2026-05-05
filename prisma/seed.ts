import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { seedUsers } from "./seeds/users.seed";
import { seedDrivers } from "./seeds/drivers.seed";
import { seedPassengers } from "./seeds/passengers.seed";
import { seedReferrals } from "./seeds/referrals.seed";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🌱 Iniciando seed...");

  await seedUsers(prisma);
  await seedDrivers(prisma);
  await seedPassengers(prisma);
  await seedReferrals(prisma);

  console.log("\n✅ Seed completo!\n");
  console.log("🔑 Logins disponíveis (senha: 123456):");
  console.log("   mottapedro01@gmail.com  (DRIVER)");
  console.log("   carlos@driver.com       (DRIVER)");
  console.log("   marcos@driver.com       (DRIVER)");
  console.log("   roberto@driver.com      (DRIVER)");
  console.log("   jlcbrito@driver.com     (DRIVER)");
  console.log("   ana@passenger.com       (PASSENGER)");
  console.log("   bruno@passenger.com     (PASSENGER)");
}

main()
  .catch((e) => {
    console.error("🔥 Erro no seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

// Legacy content below — kept for reference but not executed
function _legacy() {}
