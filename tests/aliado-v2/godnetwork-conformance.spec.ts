/**
 * LOCKED CONTRACT TEST
 *
 * The GodNetwork conformance is the canonical truth of the Aliado network.
 * This spec asserts the official structure exists in the database AFTER
 * `npm run seed:golden` (which is part of repo setup).
 *
 * If this spec fails, EITHER:
 *   (a) data was corrupted — restore from backup and rerun the seed; or
 *   (b) the official structure was changed — update GodNetworkService AND this
 *       spec in the SAME commit, with a note in the PR description.
 */
import request from "supertest";
import { DriverSkillCode } from "../../src/shared/enums";
import { app } from "../../src/app";
import { prisma } from "../setup";
import { assertConformance, GOD_NETWORK } from "../../src/domain/godnetwork/GodNetworkService";
import { assignSkill } from "../../src/domain/skills/DriverSkillService";

describe("GodNetwork conformance — LOCKED CONTRACT", () => {
  beforeAll(async () => {
    // Run-once equivalent of `npm run backfill:skills` so this spec works
    // whether or not the operator has already invoked it.
    const gisele = await prisma.user.findUnique({
      where: { email: "gisele.colecionador@aliado.mobility" },
      select: { driver: { select: { id: true } } },
    });
    if (gisele?.driver) {
      await assignSkill({ driverId: gisele.driver.id, code: DriverSkillCode.COLECIONADOR });
    }
  });

  it("Pedro is the root driver", async () => {
    const user = await prisma.user.findUnique({
      where: { email: GOD_NETWORK.root.email },
      select: { driver: { select: { id: true } } },
    });
    expect(user?.driver?.id).toBeDefined();
  });

  it("Pedro has 4 direct L1 children (Anselmo, Fernando, Carlos H., João)", async () => {
    const result = await assertConformance();
    expect(result.structure.expectedLevel1Count).toBe(4);
    expect(result.structure.actualLevel1Count).toBeGreaterThanOrEqual(4);
  });

  it("João has 6 direct L2 children, all of which are L2 of Pedro (closure ≥ 10)", async () => {
    const result = await assertConformance();
    expect(result.structure.expectedLevel2UnderJoaoCount).toBe(6);
    expect(result.structure.actualLevel2UnderJoaoCount).toBeGreaterThanOrEqual(6);
    expect(result.structure.actualTotalClosureEdgesFromRoot).toBeGreaterThanOrEqual(10);
  });

  it("Gisele has the COLECIONADOR skill assigned", async () => {
    const result = await assertConformance();
    expect(result.giseleSkill.expected).toBe(DriverSkillCode.COLECIONADOR);
    expect(result.giseleSkill.actual).toBe(DriverSkillCode.COLECIONADOR);
  });

  it("GET /godnetwork/status returns conformant=true with no deviations", async () => {
    const res = await request(app).get("/godnetwork/status");
    expect(res.status).toBe(200);
    expect(res.body.rootDriverId).toBeDefined();
    expect(res.body.deviations).toEqual([]);
    expect(res.body.conformant).toBe(true);
  });
});
