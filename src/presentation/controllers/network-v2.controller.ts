import { Request, Response } from "express";
import {
  resolveOnboardingContext,
  OnboardingContextError,
} from "../../domain/onboarding/OnboardingContextService";
import { getPassengerLineage } from "../../domain/referral-network/PassengerLineageService";
import { getOwnershipMetrics } from "../../domain/referral-network/NetworkOwnershipService";
import { getNetworkRelationships } from "../../domain/referral-network/NetworkGenealogyService";
import { listDriverSkills } from "../../domain/skills/DriverSkillService";
import { prisma } from "../../infra/prisma/client";

function paramId(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? String(v[0]) : String(v);
}

export class NetworkV2Controller {
  static async getOnboardingContext(req: Request, res: Response) {
    const slug = paramId(req, "slug");
    try {
      const ctx = await resolveOnboardingContext(slug);
      return res.json(ctx);
    } catch (err) {
      if (err instanceof OnboardingContextError) {
        const msg = err.message;
        if (/not found/i.test(msg)) return res.status(404).json({ error: msg });
        if (/expired|consumed/i.test(msg)) return res.status(410).json({ error: msg });
        return res.status(400).json({ error: msg });
      }
      throw err;
    }
  }

  static async getPassengerLineage(req: Request, res: Response) {
    const id = paramId(req, "id");
    try {
      const lineage = await getPassengerLineage(id);
      return res.json(lineage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(msg)) return res.status(404).json({ error: msg });
      return res.status(400).json({ error: msg });
    }
  }

  static async getDriverOwnership(req: Request, res: Response) {
    const id = paramId(req, "id");
    const metrics = await getOwnershipMetrics(id);
    return res.json(metrics);
  }

  static async getDriverNetwork(req: Request, res: Response) {
    const id = paramId(req, "id");
    const [relationships, ownership, skills, driver] = await Promise.all([
      getNetworkRelationships(id),
      getOwnershipMetrics(id),
      listDriverSkills(id).catch(() => [] as { code: string }[]),
      prisma.driver.findUnique({ where: { id }, select: { isActive: true, experienceLevel: true } }),
    ]);
    const active = driver?.isActive ?? false;
    const level = driver?.experienceLevel ?? "";
    const capabilities = {
      canInvitePassengers: active,
      canInviteDrivers: active && (level === "PROFISSIONAL" || level === "ELITE"),
      canReceiveRewards: active,
      canExpandNetwork: active,
      skillCodes: skills.map((s) => s.code),
    };
    return res.json({ driverId: id, relationships, ownership, skills, capabilities });
  }
}
