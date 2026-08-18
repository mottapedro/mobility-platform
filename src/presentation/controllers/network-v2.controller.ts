import { Request, Response } from "express";
import {
  resolveOnboardingContext,
  OnboardingContextError,
} from "../../domain/onboarding/OnboardingContextService";
import { getPassengerLineage } from "../../domain/referral-network/PassengerLineageService";
import { getOwnershipMetrics } from "../../domain/referral-network/NetworkOwnershipService";
import { getNetworkRelationships } from "../../domain/referral-network/NetworkGenealogyService";
import { resolveDriverRoot } from "../../domain/referral-network/DriverRootResolverService";
import { listDriverSkills } from "../../domain/skills/DriverSkillService";
import { buildGenealogyProjection } from "../../domain/genealogy/BuildGenealogyProjectionService";
import {
  buildNetworkContextForDriver,
  buildNetworkContextForPassenger,
} from "../../domain/network/NetworkContextProjectionService";
import { ActorType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";

function paramId(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? String(v[0]) : String(v);
}

export class NetworkV2Controller {
  static async getOnboardingContext(req: Request, res: Response) {
    const slug = paramId(req, "slug");
    const flow = typeof req.query.flow === "string" ? req.query.flow : undefined;
    try {
      const ctx = await resolveOnboardingContext(slug, flow);
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

  /**
   * GET /network/context?actorId=<id>&actorType=DRIVER|PASSENGER
   *
   * Returns the operational network context for an authenticated actor.
   * Replaces the legacy unconditional 410 with a proper domain response.
   *
   * Responses:
   *   200 { state: "ACTIVE", ... }      — actor has a network context
   *   410 { state: "UNINITIALIZED", reason: "..." } — actor exists but has no network yet
   *   404 { error: "..." }              — actorId not found
   *   400 { error: "..." }              — missing/invalid params
   */
  static async getNetworkContext(req: Request, res: Response) {
    const actorId = Array.isArray(req.query.actorId)
      ? String(req.query.actorId[0])
      : String(req.query.actorId ?? "");
    const rawActorType = Array.isArray(req.query.actorType)
      ? String(req.query.actorType[0])
      : String(req.query.actorType ?? "");
    const actorType = rawActorType.toUpperCase() as ActorType;

    if (!actorId) {
      return res.status(400).json({ error: "actorId is required" });
    }
    if (actorType !== ActorType.DRIVER && actorType !== ActorType.PASSENGER) {
      return res.status(400).json({ error: "actorType must be DRIVER or PASSENGER" });
    }

    if (actorType === ActorType.DRIVER) {
      const driver = await prisma.driver.findUnique({
        where: { id: actorId },
        select: { id: true, isActive: true },
      });
      if (!driver) {
        return res.status(404).json({ error: `Driver ${actorId} not found` });
      }
      if (!driver.isActive) {
        return res.status(410).json({
          state: "UNINITIALIZED",
          reason: "DRIVER_INACTIVE",
          message: "Rede ainda não inicializada. Motorista inativo.",
        });
      }

      const rootDriverId = await resolveDriverRoot(ActorType.DRIVER, actorId).catch(() => null);
      if (!rootDriverId) {
        return res.status(410).json({
          state: "UNINITIALIZED",
          reason: "ROOT_DRIVER_NOT_PROPAGATED",
          message: "Rede ainda não inicializada. Aguardando ativação pelo backend.",
        });
      }

      const context = await buildNetworkContextForDriver(actorId, rootDriverId);
      return res.json(context);
    }

    // PASSENGER
    const passenger = await prisma.passenger.findUnique({
      where: { id: actorId },
      select: { id: true },
    });
    if (!passenger) {
      return res.status(404).json({ error: `Passenger ${actorId} not found` });
    }

    const rootDriverId = await resolveDriverRoot(ActorType.PASSENGER, actorId).catch(() => null);
    if (!rootDriverId) {
      return res.status(410).json({
        state: "UNINITIALIZED",
        reason: "ROOT_DRIVER_NOT_PROPAGATED",
        message: "Rede ainda não inicializada. Aguardando ativação pelo backend.",
      });
    }

    const context = await buildNetworkContextForPassenger(actorId, rootDriverId);
    return res.json(context);
  }

  /**
   * GET /drivers/:id/network/tree?maxDepth=<n>
   *
   * Returns a genealogy projection for the driver's root network.
   * The :id param is the driver's OWN id (we resolve their root first).
   *
   * Responses:
   *   200 { rootDriverId, rootDriverName, nodes, edges, levels, metrics }
   *   404 { error } — driver not found
   *   400 { error } — missing param
   */
  static async getGenealogyTree(req: Request, res: Response) {
    const driverId = paramId(req, "id");
    if (!driverId) {
      return res.status(400).json({ error: "driverId is required" });
    }

    const rawMaxDepth = req.query.maxDepth;
    const maxDepth =
      rawMaxDepth !== undefined ? Math.max(1, parseInt(String(rawMaxDepth), 10) || 10) : undefined;

    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { id: true },
    });
    if (!driver) {
      return res.status(404).json({ error: `Driver ${driverId} not found` });
    }

    const rootDriverId = await resolveDriverRoot(ActorType.DRIVER, driverId).catch(() => null);
    if (!rootDriverId) {
      return res.status(404).json({ error: "Could not resolve root driver for this driver" });
    }

    const projection = await buildGenealogyProjection(rootDriverId, { maxDepth });
    return res.json(projection);
  }
}
