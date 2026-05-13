import "dotenv/config";
import { prisma } from "../../src/infra/prisma/client";

async function validateNetwork() {
  const drivers = await prisma.driver.findMany({
    select: {
      id: true,
      publicSlug: true,
      networkLevel: true,
      regions: true,
      referralCode: true,
      referredByDriverId: true,
      user: { select: { name: true } },
    },
    orderBy: [{ networkLevel: "asc" }, { user: { name: "asc" } }],
  });

  console.log(`\n=== DRIVER NETWORK V1.2 (${drivers.length} drivers) ===`);
  for (const d of drivers) {
    const name = (d.user.name ?? "?").padEnd(30);
    const slug = (d.publicSlug ?? "—").padEnd(25);
    const regions = d.regions.join(", ");
    console.log(`  L${d.networkLevel} | ${name} | ${slug} | ${regions}`);
  }

  const edges = await prisma.driverReferral.findMany({
    select: {
      level: true,
      driver: { select: { user: { select: { name: true } } } },
      referred: { select: { user: { select: { name: true } } } },
    },
    orderBy: [{ level: "asc" }],
  });

  console.log(`\n=== REFERRAL EDGES (${edges.length}) ===`);
  for (const e of edges) {
    const referrer = e.driver.user.name;
    const referred = e.referred.user.name;
    console.log(`  L${e.level} | ${referrer} -> ${referred}`);
  }

  const directEdges = edges.filter((e) => e.level === 1).length;
  console.log(`\n✅ ${drivers.length} drivers | ${directEdges} direct edges | ${edges.length} total edges`);
}

validateNetwork()
  .catch((err) => {
    console.error("Validation failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
