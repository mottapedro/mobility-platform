import { Request, Response } from "express";
import { buildGenealogyProjection } from "../../domain/genealogy/BuildGenealogyProjectionService";
import { prisma } from "../../infra/prisma/client";

const ABSOLUTE_MAX_DEPTH = 10;

function paramId(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? String(v[0]) : String(v);
}

export class GenealogyController {
  /**
   * GET /drivers/:id/network/genealogy?maxDepth=5
   *
   * Projects the referral tree for a driver into a flat graph:
   *   nodes / edges / levels / metrics / stats / rootDriver
   *
   * This is a read-only projection — no business rules, no mutations.
   * Source of truth remains: ReferralRelationship + rootDriverId + flowType.
   */
  static async getDriverGenealogy(req: Request, res: Response) {
    const driverId = paramId(req, "id");

    const rawMaxDepth = req.query.maxDepth;
    let maxDepth: number | undefined;
    if (rawMaxDepth !== undefined) {
      const parsed = Number(rawMaxDepth);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > ABSOLUTE_MAX_DEPTH) {
        return res.status(400).json({
          error: `maxDepth must be an integer between 0 and ${ABSOLUTE_MAX_DEPTH}`,
        });
      }
      maxDepth = parsed;
    }

    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { id: true },
    });
    if (!driver) {
      return res.status(404).json({ error: `Driver ${driverId} not found` });
    }

    const projection = await buildGenealogyProjection(driverId, { maxDepth });
    return res.json(projection);
  }
}
