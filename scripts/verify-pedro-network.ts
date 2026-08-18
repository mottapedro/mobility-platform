/**
 * verify-pedro-network.ts
 * 
 * Post-backfill verification of Pedro Motta's full NetworkContext response.
 */
import { prisma } from "../src/infra/prisma/client";
import { buildNetworkContextForDriver } from "../src/domain/network/NetworkContextProjectionService";

const PEDRO_DRIVER_ID = "1e6e8e76-9477-4517-9390-d71245b9a141";

async function main() {
  console.log("=== POST-BACKFILL VERIFICATION: Pedro Motta NetworkContext ===\n");

  const ctx = await buildNetworkContextForDriver(PEDRO_DRIVER_ID, PEDRO_DRIVER_ID);

  console.log("flowType:", ctx.flowType);
  console.log("targetActorExpected:", ctx.targetActorExpected);
  console.log("rootDriver.name:", ctx.rootDriver?.name);
  console.log("rootDriver.id:", ctx.rootDriver?.id);

  const { genealogy, networkMetrics } = ctx;
  console.log("\n--- genealogy.me ---");
  console.log("  id:", genealogy.me.id, "| name:", genealogy.me.name, "| actorType:", genealogy.me.actorType);

  console.log("\n--- genealogy.ancestors ---");
  console.log("  count:", genealogy.ancestors.length);

  console.log("\n--- genealogy.descendants ---");
  console.log("  top-level count:", genealogy.descendants.length);
  for (const d of genealogy.descendants) {
    console.log(`    [depth=${d.depth}] ${d.actor.name} (${d.actor.actorType}) – children: ${d.children.length}`);
    for (const c of d.children) {
      console.log(`        [depth=${c.depth}] ${c.actor.name} (${c.actor.actorType})`);
    }
  }

  const flatCount = (nodes: typeof genealogy.descendants): number =>
    nodes.reduce((acc, n) => acc + 1 + flatCount(n.children), 0);
  const totalDescendantActors = flatCount(genealogy.descendants);
  console.log("  total descendants (recursive):", totalDescendantActors);

  const driverDescendants = genealogy.descendants.filter(d => d.actor.actorType === "driver");
  const passengerDescendants = genealogy.descendants.filter(d => d.actor.actorType === "passenger");
  console.log("  DRIVER descendants at depth-1:", driverDescendants.length);
  console.log("  PASSENGER descendants at depth-1:", passengerDescendants.length);

  console.log("\n--- networkMetrics ---");
  console.log("  totalActors:", networkMetrics.totalActors);
  console.log("  activeCount:", networkMetrics.activeCount);
  console.log("  depth:", networkMetrics.depth);

  console.log("\n--- capabilities ---");
  console.log("  canInviteDrivers:", ctx.capabilities?.canInviteDrivers);
  console.log("  canInvitePassengers:", ctx.capabilities?.canInvitePassengers);

  console.log("\n--- inviteUrls ---");
  console.log("  driverToPassenger:", ctx.inviteUrls?.driverToPassenger);
  console.log("  driverToDriver:", ctx.inviteUrls?.driverToDriver);

  // Check DB counts for reference
  const [dbD2D, dbTotalDrivers, dbTotalPassengers] = await Promise.all([
    prisma.referralRelationship.count({ where: { rootDriverId: PEDRO_DRIVER_ID, flowType: "DRIVER_TO_DRIVER" } }),
    prisma.referralRelationship.count({ where: { rootDriverId: PEDRO_DRIVER_ID, invitedActorType: "DRIVER" } }),
    prisma.passenger.count({ where: { rootDriverId: PEDRO_DRIVER_ID } }),
  ]);
  console.log("\n--- DB counts (ownership source) ---");
  console.log("  D2D rels rooted at Pedro:", dbD2D);
  console.log("  Total driver rels (invitedActorType=DRIVER):", dbTotalDrivers);
  console.log("  Passengers with rootDriverId=Pedro:", dbTotalPassengers);

  console.log("\n=== EXPECTED: MOTORISTAS =", dbTotalDrivers, "| PASSAGEIROS =", dbTotalPassengers, "| TOTAL =", dbTotalDrivers + dbTotalPassengers, "===");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
