import { prisma } from "../../infra/prisma/client";
import { RideContext } from "../../presentation/controllers/ride.controller";
import { DriverRegionMatcher } from "../../domain/services/DriverRegionMatcher";
import { MatchingCandidate, MatchingPriorityEngine } from "../../domain/services/MatchingPriorityEngine";
import { getDriverNetwork } from "../../domain/services/DriverReferralService";
import { RegionResolver } from "../../domain/services/RegionResolver";
import { logMatchingEvent } from "../../shared/logging/matchingLog";
import { AcceptancePolicyEngine } from "../../domain/services/AcceptancePolicyEngine";
import { execute as createOfferService } from "../services/CreateOfferService";
import { referralFallbackScheduler } from "../../infra/async/ReferralFallbackScheduler";

export type MatchLevel = "REFERRED" | "NETWORK_L1" | "NETWORK_L2" | "NETWORK_L3" | "GENERAL";

// Tempo de exclusividade do motorista indicado antes do fallback para MATCHING geral
// For scheduled rides this is overridden dynamically by AcceptancePolicyEngine.
const REFERRAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos (immediate rides)

/**
 * Backwards-compatible facade. The referral fallback timers are now owned by
 * `referralFallbackScheduler` and participate in `lifecycle.shutdownAsync()`.
 * This helper remains exported because legacy callers (tests, in particular)
 * import it directly; it simply delegates to the scheduler.
 */
export function clearPendingReferralFallbacks(): void {
  referralFallbackScheduler.cancelAll();
}

export interface MatchInput {
  rideId: string;
  level?: MatchLevel;
  excludedDriverIds?: string[];
  candidateDriverIds?: string[];
}

// ─── Lógica de prioridade por contexto ─────────────────────────────────────
type PriorityLevel = "HIGH" | "MEDIUM" | "LOW";

function calculatePriority(context: RideContext | null): PriorityLevel {
  if (!context) return "LOW";
  const score =
    (context.isVip     ? 4 : 0) +
    (context.isAirport ? 2 : 0) +
    (context.isPet     ? 1 : 0) +
    (context.isLuggage ? 1 : 0);
  if (score >= 4) return "HIGH";
  if (score >= 2) return "MEDIUM";
  return "LOW";
}

// Filtra e ordena drivers baseado no contexto da corrida
function applyContextFilters(
  drivers: { id: string; experienceLevel: string; vehicles: { category: string }[] }[],
  context: RideContext | null
): { id: string; experienceLevel: string; vehicles: { category: string }[] }[] {
  if (!context) return drivers;

  let filtered = [...drivers];

  // vip → priorizar ELITE primeiro
  if (context.isVip) {
    const elite = filtered.filter(d => d.experienceLevel === "ELITE");
    const others = filtered.filter(d => d.experienceLevel !== "ELITE");
    filtered = [...elite, ...others];
    console.log(`⭐ VIP: ${elite.length} drivers ELITE priorizados`);
  }

  // airport → priorizar categoria EXECUTIVO
  if (context.isAirport) {
    const exec = filtered.filter(d => d.vehicles.some(v => v.category === "EXECUTIVO"));
    const others = filtered.filter(d => !d.vehicles.some(v => v.category === "EXECUTIVO"));
    filtered = [...exec, ...others];
    console.log(`✈️ Aeroporto: ${exec.length} drivers EXECUTIVO priorizados`);
  }

  // luggage → priorizar EXECUTIVO (veículo maior)
  if (context.isLuggage && !context.isAirport) {
    const exec = filtered.filter(d => d.vehicles.some(v => v.category === "EXECUTIVO"));
    const others = filtered.filter(d => !d.vehicles.some(v => v.category === "EXECUTIVO"));
    filtered = [...exec, ...others];
    console.log(`💼 Bagagem: ${exec.length} drivers EXECUTIVO priorizados`);
  }

  // pet → por ora não filtra (simulação), apenas loga
  if (context.isPet) {
    console.log(`🐶 Pet: todos os drivers disponíveis (filtro futuro)`);
  }

  return filtered;
}

export class MatchRideUseCase {
  private readonly matchingPriorityEngine: MatchingPriorityEngine;

  constructor(
    private readonly regionResolver = new RegionResolver(),
    private readonly driverRegionMatcher = new DriverRegionMatcher()
  ) {
    this.matchingPriorityEngine = new MatchingPriorityEngine(
      this.regionResolver,
      this.driverRegionMatcher,
      { getNetwork: getDriverNetwork }
    );
  }

  private async materializeStageDrivers(
    queue: MatchingCandidate[],
    stage: MatchingCandidate["stage"],
    rideContext: RideContext | null
  ): Promise<{ id: string; experienceLevel: string; vehicles: { category: string }[] }[]> {
    const stageDriverIds = queue
      .filter((candidate) => candidate.stage === stage)
      .map((candidate) => candidate.driverId);

    if (stageDriverIds.length === 0) {
      return [];
    }

    const drivers = await prisma.driver.findMany({
      where: { id: { in: stageDriverIds }, isActive: true },
      select: { id: true, experienceLevel: true, vehicles: { select: { category: true } } },
    });

    const order = new Map(stageDriverIds.map((driverId, index) => [driverId, index]));
    drivers.sort((left, right) => {
      return (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER);
    });

    return applyContextFilters(drivers, rideContext);
  }

  private async preparePriorityDrivers(
    rideId: string,
    origin: string,
    startLevel: "NETWORK_L1" | "NETWORK_L2" | "NETWORK_L3" | "GENERAL",
    referredDriverId: string | null,
    alreadyOfferedIds: Set<string>,
    excludedDriverIds: string[],
    rideContext: RideContext | null,
    candidateDriverIds?: string[]
  ): Promise<{
    drivers: { id: string; experienceLevel: string; vehicles: { category: string }[] }[];
    resultLevel: MatchLevel;
    resolvedRegion: string;
  }> {
    const resolvedRegion = this.regionResolver.resolve(origin);
    const queue = await this.matchingPriorityEngine.buildQueue({
      rideId,
      origin,
      referredDriverId,
      startLevel,
      alreadyOfferedIds,
      excludedDriverIds,
      rideContext,
      candidateDriverIds,
    });

    logMatchingEvent({
      rideId,
      event: "candidate_stage_built",
      stage: startLevel === "GENERAL" ? "REGION" : "REFERRAL_NETWORK",
      candidateDriverIds: queue.map((candidate) => candidate.driverId),
      excludedDriverIds,
      resolvedRegion,
      metadata: { startLevel },
    });

    const networkDrivers = await this.materializeStageDrivers(queue, "REFERRAL_NETWORK", rideContext);
    const regionDrivers = await this.materializeStageDrivers(queue, "REGION", rideContext);
    const globalDrivers = await this.materializeStageDrivers(queue, "GLOBAL", rideContext);
    const drivers = [...networkDrivers, ...regionDrivers, ...globalDrivers];

    const firstStage = queue[0]?.stage;
    const resultLevel: MatchLevel = firstStage === "REFERRAL_NETWORK" ? startLevel : "GENERAL";

    return { drivers, resultLevel, resolvedRegion };
  }

  // ─── Derivar próximo nível com base no estado atual das offers ──────────────
  private async deriveLevel(
    rideId: string,
    referredDriverId: string | null
  ): Promise<MatchLevel> {
    if (!referredDriverId) return "GENERAL";

    const referredOffer = await prisma.rideOffer.findFirst({
      where: { rideRequestId: rideId, driverId: referredDriverId },
    });

    if (!referredOffer) return "REFERRED";

    // Referred driver already tried — check network levels
    const network = await getDriverNetwork(referredDriverId);

    const triedOffers = await prisma.rideOffer.findMany({
      where: { rideRequestId: rideId },
      select: { driverId: true },
    });
    const triedSet = new Set(triedOffers.map((o) => o.driverId));

    if (network.level1.some((id) => !triedSet.has(id))) return "NETWORK_L1";
    if (network.level2.some((id) => !triedSet.has(id))) return "NETWORK_L2";
    if (network.level3.some((id) => !triedSet.has(id))) return "NETWORK_L3";

    return "GENERAL";
  }

  // ─── Criar offer com tolerância a duplicidade ───────────────────────────────
  private async createOffer(rideId: string, driverId: string, expiresAt: Date) {
    const result = await createOfferService({
      rideRequestId: rideId,
      driverId,
      expiresAt,
    });
    if (result.created) {
      console.log(`📨 Offer enviada para driver ${driverId}`);
    }
    return result;
  }

  // ─── Governed sequential dispatch ───────────────────────────────────────────
  // Single source of truth for creating one PENDING offer. Enforces the
  // invariant: at most ONE active PENDING offer per ride at any time.
  // Phase 2 hardens this with a partial unique index `(rideRequestId) WHERE
  // status='PENDING'` so concurrent dispatchers cannot race; the pre-check
  // remains as a fast path for telemetry (`single_active_offer_enforced`).
  // Persists queue state on RideRequest: currentDispatchStage +
  // currentCandidateDriverId. The `stage` parameter type is the Prisma
  // DispatchStage enum's literal union — aligned 1:1 with telemetry codes.
  private async dispatchSingle(
    rideId: string,
    driverId: string,
    expiresAt: Date,
    stage: "REFERRAL_DIRECT" | "REFERRAL_NETWORK" | "REGION" | "GLOBAL",
    queueRemaining: number
  ): Promise<{ dispatched: boolean }> {
    const pendingCount = await prisma.rideOffer.count({
      where: { rideRequestId: rideId, status: "PENDING" },
    });

    if (pendingCount >= 1) {
      logMatchingEvent({
        rideId,
        event: "single_active_offer_enforced",
        stage,
        metadata: { attemptedDriverId: driverId, pendingCount },
      });
      return { dispatched: false };
    }

    try {
      const result = await this.createOffer(rideId, driverId, expiresAt);
      if (result.created) {
        // Persist queue state atomically with the dispatched offer (Phase 2).
        await prisma.rideRequest.update({
          where: { id: rideId },
          data: {
            currentDispatchStage: stage,
            currentCandidateDriverId: driverId,
          },
        });
        logMatchingEvent({
          rideId,
          event: "candidate_dispatched",
          stage,
          candidateDriverIds: [driverId],
          metadata: {
            driverId,
            queueRemaining,
            expiresAt: expiresAt.toISOString(),
          },
        });
      }
      return { dispatched: result.created };
    } catch (err: unknown) {
      // Partial unique index races: another dispatcher beat us to PENDING.
      // Treat as enforced (same outcome) and surface telemetry.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("RideOffer_one_pending_per_ride") || message.includes("Unique constraint")) {
        logMatchingEvent({
          rideId,
          event: "single_active_offer_enforced",
          stage,
          metadata: { attemptedDriverId: driverId, racedOnIndex: true },
        });
        return { dispatched: false };
      }
      throw err;
    }
  }

  /**
   * Public re-dispatch entry point. Used by RespondToRideOfferUseCase (on
   * reject) and ExpireOffersService (on expire). Derives the next stage from
   * persisted offer history and dispatches a single next candidate.
   * Replaces the previous recursive `execute({ level })` calls that broadcasted.
   */
  async dispatchNextCandidate(input: { rideId: string }): Promise<{ matched: boolean; level: MatchLevel }> {
    logMatchingEvent({
      rideId: input.rideId,
      event: "queue_advanced",
      metadata: { trigger: "dispatchNextCandidate" },
    });
    // execute() already derives level when not provided; the new single-
    // candidate logic below ensures only one offer is created.
    return this.execute({ rideId: input.rideId });
  }

  // ─── Execução principal ─────────────────────────────────────────────────────
  async execute(
    input: MatchInput
  ): Promise<{ matched: boolean; level: MatchLevel }> {
    const { rideId, candidateDriverIds } = input;

    // 1. Buscar corrida e passageiro em leituras sequenciais para evitar fan-out interno no adapter
    const ride = await prisma.rideRequest.findUnique({
      where: { id: rideId },
    });

    if (!ride) throw new Error("Ride not found");

    // Merge persisted exclusion list (Phase 2) with caller-supplied ids.
    // The persisted list survives across re-dispatches so the same driver is
    // never re-offered after rejection/expiration even if the caller forgets to forward it.
    const persistedExcluded = (ride as { excludedDriverIds?: string[] }).excludedDriverIds ?? [];
    const excludedDriverIds = Array.from(
      new Set([...(input.excludedDriverIds ?? []), ...persistedExcluded])
    );

    const passenger = await prisma.passenger.findUnique({
      where: { id: ride.passengerId },
      select: { referredByDriverId: true, rootDriverId: true },
    });

    // Guard: só faz matching em corridas que ainda podem ser matchadas
    if (!
      ["PENDING", "MATCHING", "WAITING_REFERRAL", "WAITING_PARTNER", "WAITING_GENERAL"].includes(ride.status)
    ) {
      console.log(`⚠️ Corrida ${rideId} ignorada — status: ${ride.status}`);
      return { matched: false, level: "GENERAL" };
    }

    const referredDriverId = passenger?.referredByDriverId ?? null;
    // A ride is network-owned when the passenger belongs to a driver's network
    // (rootDriverId is set via D2P or P2P-inherited referral). GENERAL dispatch
    // rides without a network passenger are excluded.
    const isNetworkOwned = !!(ride.rootDriverId || passenger?.rootDriverId);
    const rideContext = (ride.context ?? null) as RideContext | null;
    const priority = calculatePriority(rideContext);

    // Acceptance policy: compute offer TTL and cutoff from ride data.
    // Network-owned rides receive a 15-min acceptance window (immediate rides only;
    // scheduled rides already use 30 min which exceeds the network SLA).
    const policy = AcceptancePolicyEngine.computePolicy(
      ride.scheduledAt ?? null,
      isNetworkOwned,
    );
    const now = new Date();

    // Operational cutoff guard: if the redistribution deadline has passed, expire immediately.
    if (AcceptancePolicyEngine.isBeyondCutoff(now, policy)) {
      logMatchingEvent({
        rideId,
        event: "OPERATIONAL_CUTOFF_REACHED",
        metadata: {
          operationalCutoffAt: policy.operationalCutoffAt?.toISOString(),
          rideStatus: ride.status,
        },
      });
      await prisma.rideRequest.update({
        where: { id: rideId },
        data: { status: "EXPIRED" },
      });
      return { matched: false, level: "GENERAL" };
    }

    const expiresAt = AcceptancePolicyEngine.computeOfferExpiry(now, policy);
    const referralWindowMs = policy.referralWindowMs;

    logMatchingEvent({
      rideId,
      event: "ACCEPTANCE_WINDOW_CALCULATED",
      metadata: {
        isScheduled: policy.isScheduled,
        isNetworkOwned,
        operationalCutoffAt: policy.operationalCutoffAt?.toISOString() ?? null,
        offerExpiresAt: expiresAt.toISOString(),
        referralWindowMs,
      },
    });

    // 2. Derivar nível se não fornecido
    const level = input.level ?? (await this.deriveLevel(rideId, referredDriverId));

    logMatchingEvent({
      rideId,
      event: "matching_started",
      stage: level === "REFERRED" ? "REFERRAL_DIRECT" : undefined,
      excludedDriverIds,
      metadata: { level, priority, rideContext },
    });

    // 3. IDs já com offer nessa corrida (evita duplicidade e respeita re-match)
    const existingOffers = await prisma.rideOffer.findMany({
      where: { rideRequestId: rideId },
      select: { driverId: true },
    });
    const alreadyOfferedIds = new Set([
      ...existingOffers.map((o) => o.driverId),
      ...excludedDriverIds,
    ]);

    // expiresAt and referralWindowMs now come from AcceptancePolicyEngine (computed above).

    // ── Tier 1: REFERRED ─────────────────────────────────────────────────────
    if (level === "REFERRED") {
      if (!referredDriverId) {
        return this.execute({ rideId, level: "GENERAL", excludedDriverIds, candidateDriverIds });
      }

      if (alreadyOfferedIds.has(referredDriverId)) {
        return this.execute({ rideId, level: "NETWORK_L1", excludedDriverIds, candidateDriverIds });
      }

      const referredDriver = await prisma.driver.findFirst({
        where: { id: referredDriverId, isActive: true },
      });

      if (!referredDriver) {
        console.log(`⚠️ Driver indicado ${referredDriverId} inativo — escalando para NETWORK_L1`);
        return this.execute({ rideId, level: "NETWORK_L1", excludedDriverIds, candidateDriverIds });
      }

      // ✅ Modo referral: aguarda 60s antes de abrir para outros
      await prisma.rideRequest.update({
        where: { id: rideId },
        data: {
          status: "WAITING_REFERRAL",
          currentDispatchStage: "REFERRAL_DIRECT",
          currentCandidateDriverId: referredDriverId,
        },
      });

      await this.createOffer(rideId, referredDriverId, expiresAt);
      logMatchingEvent({
        rideId,
        event: "OFFER_CREATED",
        stage: "REFERRAL_DIRECT",
        candidateDriverIds: [referredDriverId],
        metadata: { expiresAt: expiresAt.toISOString() },
      });
      logMatchingEvent({
        rideId,
        event: "offers_prepared",
        stage: "REFERRAL_DIRECT",
        candidateDriverIds: [referredDriverId],
        excludedDriverIds,
        metadata: { timeoutSeconds: referralWindowMs / 1000 },
      });

      // Timeout: if still WAITING_REFERRAL after referralWindowMs → escalate.
      // Governed by referralFallbackScheduler so it participates in graceful
      // shutdown (drained via lifecycle.shutdownAsync).
      referralFallbackScheduler.schedule(referralWindowMs, async () => {
        try {
          // Atomic check-and-update: only proceeds if status is still WAITING_REFERRAL
          const updated = await prisma.rideRequest.updateMany({
            where: { id: rideId, status: "WAITING_REFERRAL" },
            data: { status: "MATCHING" },
          });

          if (updated.count === 0) return; // Already handled by accept/reject/manual-fallback

          logMatchingEvent({
            rideId,
            event: "fallback_triggered",
            stage: "REFERRAL_NETWORK",
            excludedDriverIds: [...excludedDriverIds, referredDriverId],
          });

          // Expirar offer ainda pendente do driver indicado (evita aceitação tardia)
          await prisma.rideOffer.updateMany({
            where: { rideRequestId: rideId, driverId: referredDriverId, status: "PENDING" },
            data: { status: "EXPIRED" },
          });

          await this.execute({
            rideId,
            level: "NETWORK_L1",
            excludedDriverIds: [...excludedDriverIds, referredDriverId],
            candidateDriverIds,
          });
        } catch (err) {
          console.error(`🔥 Erro no timeout referral para corrida ${rideId}:`, err);
        }
      });

      return { matched: true, level };
    }

    // ── Tier 2-4: NETWORK LEVELS ─────────────────────────────────────────────
    if (level === "NETWORK_L1" || level === "NETWORK_L2" || level === "NETWORK_L3") {
      if (!referredDriverId) {
        return this.execute({ rideId, level: "GENERAL", excludedDriverIds, candidateDriverIds });
      }

      // Phase 3: lifecycle status reflects current dispatch tier so the frontend
      // can render "Buscando motoristas da rede de Pedro" instead of generic "MATCHING".
      await prisma.rideRequest.update({
        where: { id: rideId },
        data: { status: "WAITING_PARTNER" },
      });

      const { drivers, resultLevel, resolvedRegion } = await this.preparePriorityDrivers(
        rideId,
        ride.origin,
        level,
        referredDriverId,
        alreadyOfferedIds,
        excludedDriverIds,
        rideContext,
        candidateDriverIds
      );

      if (drivers.length === 0) {
        logMatchingEvent({
          rideId,
          event: "matching_finished",
          stage: "GLOBAL",
          excludedDriverIds,
          resolvedRegion,
          metadata: { matched: false, startLevel: level },
        });
        return { matched: false, level: resultLevel };
      }

      const networkStage = resultLevel === "GENERAL" ? "REGION" : "REFERRAL_NETWORK";
      const networkPick = drivers[0];
      logMatchingEvent({
        rideId,
        event: "offers_prepared",
        stage: networkStage,
        candidateCount: drivers.length,
        previewCandidateIds: drivers.slice(0, 3).map((driver) => driver.id),
        excludedDriverIds,
        resolvedRegion,
      });
      await this.dispatchSingle(
        rideId,
        networkPick.id,
        expiresAt,
        networkStage,
        drivers.length - 1
      );
      return { matched: true, level: resultLevel };
    }

    // ── Tier 3: GENERAL ───────────────────────────────────────────────────────
    // Phase 3: WAITING_GENERAL signals the frontend that the partner network
    // is exhausted and the search has expanded to all available regional drivers.
    await prisma.rideRequest.update({
      where: { id: rideId },
      data: { status: "WAITING_GENERAL" },
    });

    const { drivers: generalDrivers, resolvedRegion } = await this.preparePriorityDrivers(
      rideId,
      ride.origin,
      "GENERAL",
      referredDriverId,
      alreadyOfferedIds,
      excludedDriverIds,
      rideContext,
      candidateDriverIds
    );

    if (generalDrivers.length === 0) {
      logMatchingEvent({
        rideId,
        event: "matching_finished",
        stage: "GLOBAL",
        excludedDriverIds,
        resolvedRegion,
        metadata: { matched: false, startLevel: level },
      });
      return { matched: false, level };
    }

    const generalStage = "REGION" as const;
    const generalPick = generalDrivers[0];
    logMatchingEvent({
      rideId,
      event: "offers_prepared",
      stage: generalStage,
      candidateCount: generalDrivers.length,
      previewCandidateIds: generalDrivers.slice(0, 3).map((driver) => driver.id),
      excludedDriverIds,
      resolvedRegion,
    });
    await this.dispatchSingle(
      rideId,
      generalPick.id,
      expiresAt,
      generalStage,
      generalDrivers.length - 1
    );
    return { matched: true, level };
  }
}
