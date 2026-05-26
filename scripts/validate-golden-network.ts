import { prisma } from "../src/infra/prisma/client";

async function main() {
  const pedroUser = await prisma.user.findUnique({
    where: { email: "mottapedro01@gmail.com" },
    include: { driver: true },
  });

  if (!pedroUser?.driver) {
    console.error("Pedro not found in DB");
    process.exit(1);
  }

  const pid = pedroUser.driver.id;
  console.log(`✅ Pedro Paulo Motta — driver.id=${pid}`);

  const refs = await prisma.driverReferral.findMany({
    where: { referrerDriverId: pid },
    orderBy: [{ level: "asc" }, { isDirect: "desc" }],
  });

  console.log(`   Total edges via Pedro: ${refs.length}`);
  const direct = refs.filter((r) => r.isDirect);
  const inherited = refs.filter((r) => !r.isDirect);
  console.log(`   Direct   level-1: ${direct.length} (expected 4)`);
  console.log(`   Inherited level-2: ${inherited.length} (expected 6)`);

  for (const r of refs) {
    const d = await prisma.driver.findUnique({
      where: { id: r.referredDriverId },
      include: { user: true },
    });
    const tag = r.isDirect ? "DIRECT  " : "HERDADO ";
    console.log(`     ${tag} level=${r.level}  ${d?.user.name}`);
  }

  const giseleUser = await prisma.user.findUnique({
    where: { email: "gisele.colecionador@aliado.mobility" },
    include: { driver: true },
  });
  console.log(`\n   Gisele metadata: ${JSON.stringify(giseleUser?.driver?.metadata)}`);

  const ok = direct.length === 4 && inherited.length === 6;
  if (ok) {
    console.log("\n🌟 Golden Network Oficial VALIDADA — tudo correto!");
  } else {
    console.error(`\n❌ FALHA: esperado 4 direct + 6 inherited, obtido ${direct.length} + ${inherited.length}`);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
