/**
 * Backfill — assign COLECIONADOR skill to Gisele.
 * Idempotent. Usage: npm run backfill:skills
 */
import { DriverSkillCode } from "@prisma/client";
import { prisma } from "../src/infra/prisma/client";
import { assignSkill } from "../src/domain/skills/DriverSkillService";

const GISELE_EMAIL = "gisele.colecionador@aliado.mobility";

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: GISELE_EMAIL },
    select: { driver: { select: { id: true, referralCode: true } } },
  });

  if (!user?.driver) {
    console.warn(`[backfill-skills] Gisele driver not found (${GISELE_EMAIL}); skipping`);
    await prisma.$disconnect();
    process.exit(0);
  }

  const row = await assignSkill({
    driverId: user.driver.id,
    code: DriverSkillCode.COLECIONADOR,
  });

  console.log(
    `[backfill-skills] Gisele (${user.driver.referralCode}) → COLECIONADOR (row id ${row.id})`
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[backfill-skills] fatal:", e);
  await prisma.$disconnect();
  process.exit(1);
});
