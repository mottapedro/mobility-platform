import { DriverSkillCode } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { listDriverSkills } from "../skills/DriverSkillService";

/**
 * The LOCKED CONTRACT.
 *
 * GodNetwork is the canonical, official Aliado network structure used as the
 * conformance baseline. Any change to this structure is an explicit, reviewed
 * change to this file AND to the conformance test.
 *
 * Principle:
 *   Frontend renders. Backend governs. Database guarantees.
 *   Domain services orchestrate. GodNetwork defines truth.
 */

export const GOD_NETWORK = {
  root: { email: "mottapedro01@gmail.com", name: "Pedro Paulo Motta" },
  level1: {
    direct: [
      { email: "anselmo.valle@aliado.mobility", name: "Anselmo Valle" },
      { email: "fernando.barreira@aliado.mobility", name: "Fernando Barreira" },
      { email: "carlos.henrique@aliado.mobility", name: "Carlos Henrique" },
      { email: "jln@gmail.com", name: "João Luiz Correa de Brito" },
    ],
  },
  level2UnderJoao: [
    { email: "carlinhos.city@aliado.mobility", name: "Carlinhos" },
    { email: "jenner.spin@aliado.mobility", name: "Jenner" },
    { email: "bira.onix@aliado.mobility", name: "Bira" },
    {
      email: "gisele.colecionador@aliado.mobility",
      name: "Gisele",
      skill: DriverSkillCode.COLECIONADOR,
    },
    { email: "fabio.tcross@aliado.mobility", name: "Fábio" },
    { email: "andre.cabral@aliado.mobility", name: "André Cabral" },
  ],
} as const;

export interface GodNetworkConformance {
  conformant: boolean;
  rootDriverId: string | null;
  structure: {
    expectedLevel1Count: number;
    actualLevel1Count: number;
    expectedLevel2UnderJoaoCount: number;
    actualLevel2UnderJoaoCount: number;
    expectedTotalClosureEdgesFromRoot: number;
    actualTotalClosureEdgesFromRoot: number;
  };
  giseleSkill: { expected: DriverSkillCode; actual: DriverSkillCode | null };
  deviations: string[];
}

async function findDriverIdByEmail(email: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { driver: { select: { id: true } } },
  });
  return user?.driver?.id ?? null;
}

export async function getRootDriverId(): Promise<string | null> {
  return findDriverIdByEmail(GOD_NETWORK.root.email);
}

export async function assertConformance(): Promise<GodNetworkConformance> {
  const deviations: string[] = [];

  const rootDriverId = await getRootDriverId();
  if (!rootDriverId) {
    return {
      conformant: false,
      rootDriverId: null,
      structure: {
        expectedLevel1Count: GOD_NETWORK.level1.direct.length,
        actualLevel1Count: 0,
        expectedLevel2UnderJoaoCount: GOD_NETWORK.level2UnderJoao.length,
        actualLevel2UnderJoaoCount: 0,
        expectedTotalClosureEdgesFromRoot: 10,
        actualTotalClosureEdgesFromRoot: 0,
      },
      giseleSkill: {
        expected: DriverSkillCode.COLECIONADOR,
        actual: null,
      },
      deviations: [`Root driver (${GOD_NETWORK.root.email}) not found`],
    };
  }

  // ── L1: direct edges from Pedro ─────────────────────────────────────────
  const l1Rows = await prisma.driverReferral.findMany({
    where: { referrerDriverId: rootDriverId, level: 1, isDirect: true },
    select: { referredDriverId: true },
  });
  const l1Ids = new Set(l1Rows.map((r) => r.referredDriverId));

  for (const expected of GOD_NETWORK.level1.direct) {
    const id = await findDriverIdByEmail(expected.email);
    if (!id) deviations.push(`Missing L1 driver: ${expected.email}`);
    else if (!l1Ids.has(id))
      deviations.push(`Driver ${expected.email} is not a direct L1 of root`);
  }

  // ── L2: João → 6 children ───────────────────────────────────────────────
  const joaoId = await findDriverIdByEmail("jln@gmail.com");
  let l2Ids = new Set<string>();
  if (joaoId) {
    const l2Rows = await prisma.driverReferral.findMany({
      where: { referrerDriverId: joaoId, level: 1, isDirect: true },
      select: { referredDriverId: true },
    });
    l2Ids = new Set(l2Rows.map((r) => r.referredDriverId));
  }

  let giseleActualSkill: DriverSkillCode | null = null;
  for (const expected of GOD_NETWORK.level2UnderJoao) {
    const id = await findDriverIdByEmail(expected.email);
    if (!id) {
      deviations.push(`Missing L2 driver: ${expected.email}`);
      continue;
    }
    if (joaoId && !l2Ids.has(id))
      deviations.push(`Driver ${expected.email} is not a direct child of João`);

    if ("skill" in expected && expected.skill) {
      const skills = await listDriverSkills(id);
      const found = skills.find((s) => s.code === expected.skill);
      if (expected.email === "gisele.colecionador@aliado.mobility") {
        giseleActualSkill = found ? found.code : null;
      }
      if (!found) deviations.push(`Driver ${expected.email} missing skill ${expected.skill}`);
    }
  }

  // ── Closure edges rooted at Pedro: 10 (4 direct L1 + 6 inherited L2) ───
  const closureCount = await prisma.driverReferral.count({
    where: { referrerDriverId: rootDriverId },
  });

  const structure = {
    expectedLevel1Count: GOD_NETWORK.level1.direct.length,
    actualLevel1Count: l1Ids.size,
    expectedLevel2UnderJoaoCount: GOD_NETWORK.level2UnderJoao.length,
    actualLevel2UnderJoaoCount: l2Ids.size,
    expectedTotalClosureEdgesFromRoot: 10,
    actualTotalClosureEdgesFromRoot: closureCount,
  };

  if (closureCount < 10) {
    deviations.push(
      `Closure edges rooted at Pedro = ${closureCount}; expected ≥10`
    );
  }

  return {
    conformant: deviations.length === 0,
    rootDriverId,
    structure,
    giseleSkill: {
      expected: DriverSkillCode.COLECIONADOR,
      actual: giseleActualSkill,
    },
    deviations,
  };
}

export function getOfficialStructure() {
  return GOD_NETWORK;
}
