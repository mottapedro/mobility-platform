import { PrismaClient } from "@prisma/client";
import { createDriverReferralChain } from "../src/domain/services/DriverReferralService";

const prisma = new PrismaClient();

async function mkDriver(name: string, email: string, phone: string, code: string) {
  const u = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      role: "DRIVER",
      driver: {
        create: { experienceLevel: "PROFISSIONAL", isActive: true, referralCode: code, regions: ["ZN"] },
      },
    },
    include: { driver: true },
  });
  return u.driver!;
}

async function main() {
  const pedro = await mkDriver("Pedro", "pedro@sqldemo4.com", "21930001111", "PED4");
  const joao = await mkDriver("João", "joao@sqldemo4.com", "21930002222", "JOA4");
  const carlinhos = await mkDriver("Carlinhos", "carlinhos@sqldemo4.com", "21930003333", "CAR4");

  await createDriverReferralChain(joao.id, pedro.id);
  await createDriverReferralChain(carlinhos.id, joao.id);

  const rows = await prisma.driverReferral.findMany({
    where: {
      OR: [
        { referrerDriverId: { in: [pedro.id, joao.id, carlinhos.id] } },
        { referredDriverId: { in: [pedro.id, joao.id, carlinhos.id] } },
      ],
    },
    orderBy: [{ level: "asc" }, { isDirect: "desc" }],
  });

  const ids: Record<string, string> = {
    [pedro.id]: "Pedro",
    [joao.id]: "João",
    [carlinhos.id]: "Carlinhos",
  };

  console.log("=== CLOSURE TABLE ===");
  console.log("referrer         -> referred        | level | isDirect");
  console.log("-".repeat(60));
  for (const r of rows) {
    const ref = (ids[r.referrerDriverId] ?? r.referrerDriverId.slice(0, 8)).padEnd(16);
    const red = (ids[r.referredDriverId] ?? r.referredDriverId.slice(0, 8)).padEnd(16);
    console.log(`${ref} -> ${red} | ${r.level}     | ${r.isDirect}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
