import { prisma } from "../src/infra/prisma/client";

const PEDRO_DRIVER_ID = "1e6e8e76-9477-4517-9390-d71245b9a141";

async function main() {
  // 1. DriverReferral rows involving Pedro
  const dr = await prisma.driverReferral.findMany({
    where: {
      OR: [
        { referrerDriverId: PEDRO_DRIVER_ID },
        { referredDriverId: PEDRO_DRIVER_ID },
      ],
    },
  });
  console.log("\n=== DRIVER_REFERRAL rows ===");
  console.log(JSON.stringify(dr, null, 2));

  // 2. All DriverReferral rows (full table — is it populated at all?)
  const allDr = await prisma.driverReferral.findMany({ take: 30 });
  console.log("\n=== ALL DriverReferral (up to 30) ===");
  console.log(`Count: ${allDr.length}`);
  console.log(JSON.stringify(allDr, null, 2));

  // 3. Drivers with referredByDriverId = Pedro
  const descDrivers = await prisma.driver.findMany({
    where: { referredByDriverId: PEDRO_DRIVER_ID },
    select: {
      id: true,
      referredByDriverId: true,
      isActive: true,
      publicSlug: true,
      networkLevel: true,
      experienceLevel: true,
    },
  });
  console.log("\n=== DRIVERS directly referred by Pedro ===");
  console.log(JSON.stringify(descDrivers, null, 2));

  // 4. All ReferralRelationship rooted at Pedro
  const allRels = await prisma.referralRelationship.findMany({
    where: { rootDriverId: PEDRO_DRIVER_ID },
    select: {
      id: true,
      inviterActorType: true,
      inviterId: true,
      invitedActorType: true,
      invitedId: true,
      flowType: true,
      rootDriverId: true,
    },
  });
  console.log("\n=== ALL ReferralRelationship rooted at Pedro ===");
  console.log(`Count: ${allRels.length}`);
  console.log(JSON.stringify(allRels, null, 2));

  // 5. D2D rels specifically
  const d2d = allRels.filter((r) => r.flowType === "DRIVER_TO_DRIVER");
  console.log(`\nD2D rels: ${d2d.length}`);
  console.log(JSON.stringify(d2d, null, 2));

  // 6. All drivers in the DB (small table presumably)
  const allDrivers = await prisma.driver.findMany({
    take: 30,
    select: {
      id: true,
      referredByDriverId: true,
      isActive: true,
      publicSlug: true,
      networkLevel: true,
    },
  });
  console.log("\n=== ALL Drivers (up to 30) ===");
  console.log(`Count: ${allDrivers.length}`);
  console.log(JSON.stringify(allDrivers, null, 2));

  // 7. BuildGenealogyProjection raw output — run the service
  const { buildGenealogyProjection } = await import(
    "../src/domain/genealogy/BuildGenealogyProjectionService"
  );
  const projection = await buildGenealogyProjection(PEDRO_DRIVER_ID, {
    maxDepth: 5,
  });
  console.log("\n=== BuildGenealogyProjection output ===");
  console.log("stats:", JSON.stringify(projection.stats, null, 2));
  console.log("rootDriver:", JSON.stringify(projection.rootDriver, null, 2));
  console.log("nodes count:", projection.nodes.length);
  console.log("edges count:", projection.edges.length);
  console.log("nodes:", JSON.stringify(projection.nodes, null, 2));
  console.log("edges:", JSON.stringify(projection.edges, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
