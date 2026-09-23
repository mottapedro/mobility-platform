import { prisma } from "../../infra/prisma/client";
import { RideContext } from "../../presentation/controllers/ride.controller";
import { DriverRegionMatcher } from "../../domain/services/DriverRegionMatcher";
import { MatchingCandidate, MatchingPriorityEngine } from "../../domain/services/MatchingPriorityEngine";
import { getDriverNetwork } from "../../domain/services/DriverReferralService";
import { RegionResolver } from "../../domain/services/RegionResolver";
import { logMatchingEvent } from "../../shared/logging/matchingLog";
import { AcceptancePolicyEngine } from "../../domain/services/AcceptancePolicyEngine";
import { DriverOriginResolver } from "../../domain/pricing/DriverOriginResolver";
import { execute as createOfferService } from "../services/CreateOfferService";
import { referralFallbackScheduler } from "../../infra/async/ReferralFallbackScheduler";
import { initializeDispatchRound } from "../services/InitializeDispatchRoundService";
import type { RideStatus } from "../../shared/enums";

export type MatchLevel = "REFERRED" | "NETWORK_L1" | "NETWORK_L2" | "NETWORK_L3" | "GENERAL";

export const MATCHABLE_RIDE_STATUSES = [
  "PENDING",
  "MATCHING",
  "WAITING_REFERRAL",
  "WAITING_PARTNER",
  "WAITING_GENERAL",
] as const satisfies readonly RideStatus[];

export function isMatchableRideStatus(status: RideStatus): boolean {
  return MATCHABLE_RIDE_STATUSES.some((matchableStatus) => matchableStatus === status);
}

export type MatchRideOutcome =
  | "MATCHED"
  | "NETWORK_EXHAUSTED"
  | "OPERATIONAL_CUTOFF"
  | "NO_MATCH_AVAILABLE"
  | "STALE_LIFECYCLE";

export interface MatchRideResult {
  outcome: MatchRideOutcome;
  offerId?: string;
  matched: boolean;
  level?: MatchLevel;
  reason?: string;
  driverId?: string;
}

type CandidateDispatchStage = "REFERRAL_DIRECT" | "REFERRAL_NETWORK" | "REGION" | "GLOBAL";

function rideStatusForDispatchStage(stage: CandidateDispatchStage): RideStatus {
  return stage === "REFERRAL_DIRECT"
    ? "WAITING_REFERRAL"
    : stage === "REFERRAL_NETWORK"
      ? "WAITING_PARTNER"
      : "WAITING_GENERAL";
}

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
    private readonly driverRegionMatcher = new DriverRegionMatcher(),
    private readonly driverOriginResolver = new DriverOriginResolver(),
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
    dispatchStage: MatchingCandidate["stage"];
    stageByDriverId: ReadonlyMap<string, MatchingCandidate["stage"]>;
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

    const dispatchStage: MatchingCandidate["stage"] = networkDrivers.length > 0
      ? "REFERRAL_NETWORK"
      : regionDrivers.length > 0
        ? "REGION"
        : "GLOBAL";
    const resultLevel: MatchLevel = dispatchStage === "REFERRAL_NETWORK" ? startLevel : "GENERAL";
    const stageByDriverId = new Map<string, MatchingCandidate["stage"]>([
      ...networkDrivers.map((driver) => [driver.id, "REFERRAL_NETWORK"] as const),
      ...regionDrivers.map((driver) => [driver.id, "REGION"] as const),
      ...globalDrivers.map((driver) => [driver.id, "GLOBAL"] as const),
    ]);

    return { drivers, resultLevel, resolvedRegion, dispatchStage, stageByDriverId };
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
  // Fase E — a oferta carrega o snapshot do contrato: pickup distance (M→A)
  // do novo candidato, distância da corrida e recebível congelado da quote.
  // O snapshot é não-fatal: falha de resolução de origem ou ausência de quote
  // apenas deixa os campos null (a oferta e o dispatch continuam idênticos à
  // fase anterior). O passageiro nunca é re-precificado no redispatch.
  private async createOffer(rideId: string, driverId: string, expiresAt: Date) {
    const result = await createOfferService({
      rideRequestId: rideId,
      driverId,
      expiresAt,
      ...(await this.computeOfferSnapshot(rideId, driverId)),
    });
    if (result.created) {
      console.log(`📨 Offer enviada para driver ${driverId}`);
    }
    return result;
  }

  private async computeOfferSnapshot(
    rideId: string,
    driverId: string,
  ): Promise<{
    driverToPickupDistanceKm: number | null;
    rideDistanceKm: number | null;
    driverReceivableAmountCents: number | null;
  }> {
    try {
      const [quote, ride] = await Promise.all([
        prisma.rideQuote.findFirst({
          where: { rideRequestId: rideId, status: "AGREED" },
          orderBy: { createdAt: "desc" },
        }),
        prisma.rideRequest.findUnique({
          where: { id: rideId },
          select: {
            originLat: true,
            originLng: true,
            distanceKm: true,
            scheduledAt: true,
          },
        }),
      ]);

      if (!quote || !ride) {
        return {
          driverToPickupDistanceKm: null,
          rideDistanceKm: null,
          driverReceivableAmountCents: null,
        };
      }

      let pickupKm = quote.distanceMtoAKm;
      if (
        driverId !== quote.pricingDriverId &&
        ride.originLat !== null &&
        ride.originLng !== null
      ) {
        // M2/M3 — distância M→A do novo candidato, sem tocar no contrato
        // congelado (gross/recebível da quote permanecem os mesmos).
        const origin = await this.driverOriginResolver.resolveOriginForDriver({
          driverId,
          rideLat: ride.originLat,
          rideLng: ride.originLng,
          mode: ride.scheduledAt ? "SCHEDULED" : "IMMEDIATE",
        });
        if (origin.resolved) {
          pickupKm = origin.distanceMtoAKm;
        }
      }

      return {
        driverToPickupDistanceKm: pickupKm,
        rideDistanceKm: quote.distanceAtoBKm ?? ride.distanceKm,
        driverReceivableAmountCents: quote.driverReceivableAmountCents,
      };
    } catch (error) {
      console.warn(
        `[MatchRideUseCase] snapshot da oferta indisponível (não-fatal):`,
        error instanceof Error ? error.message : error,
      );
      return {
        driverToPickupDistanceKm: null,
        rideDistanceKm: null,
        driverReceivableAmountCents: null,
      };
    }
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
    stage: CandidateDispatchStage,
    queueRemaining: number
  ): Promise<{
    dispatched: boolean;
    offerId?: string;
    activeOfferExists: boolean;
    activeOfferId?: string;
    activeOfferDriverId?: string;
  }> {
    const pendingCount = await prisma.rideOffer.count({
      where: { rideRequestId: rideId, status: "PENDING" },
    });

    if (pendingCount >= 1) {
      const activeOffer = await prisma.rideOffer.findFirst({
        where: { rideRequestId: rideId, status: "PENDING" },
        select: { id: true, driverId: true },
      });
      logMatchingEvent({
        rideId,
        event: "single_active_offer_enforced",
        stage,
        metadata: { attemptedDriverId: driverId, pendingCount },
      });
      return {
        dispatched: false,
        activeOfferExists: true,
        activeOfferId: activeOffer?.id,
        activeOfferDriverId: activeOffer?.driverId,
      };
    }

    try {
      const result = await this.createOffer(rideId, driverId, expiresAt);
      if (result.created) {
        // CAS prevents a concurrent accept/cancel from being overwritten by a
        // stale dispatcher after the offer row has been created.
        const rideUpdated = await prisma.rideRequest.updateMany({
          where: {
            id: rideId,
            status: { in: [...MATCHABLE_RIDE_STATUSES] },
          },
          data: {
            status: rideStatusForDispatchStage(stage),
            currentDispatchStage: stage,
            currentCandidateDriverId: driverId,
          },
        });

        if (rideUpdated.count === 0) {
          await prisma.rideOffer.updateMany({
            where: { id: result.offer.id, status: "PENDING" },
            data: { status: "EXPIRED" },
          });
          return { dispatched: false, activeOfferExists: false };
        }
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
      return {
        dispatched: result.created,
        offerId: result.offer.id,
        activeOfferExists: true,
        activeOfferId: result.offer.id,
        activeOfferDriverId: driverId,
      };
    } catch (err: unknown) {
      // Partial unique index races: another dispatcher beat us to PENDING.
      // Treat as enforced (same outcome) and surface telemetry.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("RideOffer_one_pending_per_ride") || message.includes("Unique constraint")) {
        const activeOffer = await prisma.rideOffer.findFirst({
          where: { rideRequestId: rideId, status: "PENDING" },
          select: { id: true, driverId: true },
        });
        logMatchingEvent({
          rideId,
          event: "single_active_offer_enforced",
          stage,
          metadata: { attemptedDriverId: driverId, racedOnIndex: true },
        });
        return {
          dispatched: false,
          activeOfferExists: true,
          activeOfferId: activeOffer?.id,
          activeOfferDriverId: activeOffer?.driverId,
        };
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
  async dispatchNextCandidate(input: { rideId: string }): Promise<MatchRideResult> {
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
  ): Promise<MatchRideResult> {
    const { rideId, candidateDriverIds } = input;

    console.log("🔥 BUSCANDO RIDE:", rideId);

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
    if (!isMatchableRideStatus(ride.status)) {
      console.log(`⚠️ Corrida ${rideId} ignorada — status: ${ride.status}`);
      return this.toResult("STALE_LIFECYCLE", "GENERAL", { reason: `ride_status_not_matchable: ${ride.status}` });
    }

    await initializeDispatchRound(rideId);

    const referredDriverId = passenger?.referredByDriverId ?? null;
    const dispatchRootDriverId = ride.rootDriverId ?? passenger?.rootDriverId ?? referredDriverId;
    // A ride is network-owned when the passenger belongs to a driver's network
    // (rootDriverId is set via D2P or P2P-inherited referral). GENERAL dispatch
    // rides without a network passenger are excluded. This is now controlled by rootDriverId on RideRequest.
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
        data: { status: "CANCELLED" },
      });
      return this.toResult("OPERATIONAL_CUTOFF", "GENERAL", { reason: "operational_cutoff_reached" });
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
    const level = input.level ?? (await this.deriveLevel(rideId, dispatchRootDriverId));

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

    // ── Stage 1: OWNER_DISPATCH ──────────────────────────────────────────────
    if (level === "REFERRED") {
      if (!dispatchRootDriverId) {
        return this.execute({ rideId, level: "GENERAL", excludedDriverIds, candidateDriverIds });
      }

      if (alreadyOfferedIds.has(dispatchRootDriverId)) {
        return this.execute({ rideId, level: "NETWORK_L1", excludedDriverIds, candidateDriverIds });
      }

      const directDriver = await prisma.driver.findFirst({
        where: { id: dispatchRootDriverId, isActive: true },
      });

      if (!directDriver) {
        return this.execute({ rideId, level: "NETWORK_L1", excludedDriverIds, candidateDriverIds });
      }

      const dispatchSingleResult = await this.dispatchSingle(
        rideId,
        dispatchRootDriverId,
        expiresAt,
        "REFERRAL_DIRECT",
        0,
      );
      logMatchingEvent({
        rideId,
        event: "OFFER_CREATED",
        stage: "REFERRAL_DIRECT",
        candidateDriverIds: [dispatchRootDriverId],
        metadata: { expiresAt: expiresAt.toISOString() },
      });

      if (dispatchSingleResult.dispatched) referralFallbackScheduler.schedule(rideId, referralWindowMs, async () => {
        try {
          const updated = await prisma.rideRequest.updateMany({
            where: {
              id: rideId,
              status: "WAITING_REFERRAL",
              currentDispatchStage: "REFERRAL_DIRECT",
            },
            data: {
              status: "MATCHING",
              currentDispatchStage: "NETWORK_DISPATCH",
            },
          });

          if (updated.count === 0) return;

          logMatchingEvent({
            rideId,
            event: "fallback_triggered",
            stage: "REFERRAL_NETWORK",
            excludedDriverIds: [...excludedDriverIds, dispatchRootDriverId],
          });

          await prisma.rideOffer.updateMany({
            where: { rideRequestId: rideId, driverId: dispatchRootDriverId, status: "PENDING" },
            data: { status: "EXPIRED" },
          });

          await this.execute({
            rideId,
            level: "NETWORK_L1",
            excludedDriverIds: [...excludedDriverIds, dispatchRootDriverId],
            candidateDriverIds,
          });
        } catch (err) {
          console.error(`🔥 Erro no timeout referral para corrida ${rideId}:`, err);
        }
      });

      if (dispatchSingleResult.activeOfferExists) {
        return this.toResult("MATCHED", "REFERRED", {
          offerId: dispatchSingleResult.activeOfferId,
          driverId: dispatchSingleResult.activeOfferDriverId,
        });
      }
      if (dispatchSingleResult.dispatched) {
        return this.toResult("MATCHED", "REFERRED", { offerId: dispatchSingleResult.offerId, driverId: dispatchRootDriverId });
      }
      return this.toResult("NO_MATCH_AVAILABLE", "REFERRED", { reason: "dispatch_single_failed_no_active_offer" });
    }

    // ── Stage 2: NETWORK_DISPATCH ────────────────────────────────────────────
    if (level === "NETWORK_L1" || level === "NETWORK_L2" || level === "NETWORK_L3") {
      if (!dispatchRootDriverId) {
        return this.execute({ rideId, level: "GENERAL", excludedDriverIds, candidateDriverIds });
      }

      const {
        drivers,
        resultLevel,
        resolvedRegion,
        dispatchStage,
        stageByDriverId,
      } = await this.preparePriorityDrivers(
        rideId,
        ride.origin,
        level,
        dispatchRootDriverId,
        alreadyOfferedIds,
        excludedDriverIds,
        rideContext,
        candidateDriverIds
      );

      // Filter drivers based on OperationalZone
      // Resolve candidate zone names from the ride origin/destination via RegionResolver.
      // If no operational zones are configured (or none match), the filter is a no-op
      // so matching does not break due to missing seed data. This is a soft filter: it
      // intersects the candidate pool with drivers assigned to the resolved zones.
      const originRegion = this.regionResolver.resolve(ride.origin);
      const destinationRegion = this.regionResolver.resolve(ride.destination);
      const zoneNames = Array.from(
        new Set([originRegion, destinationRegion].filter(Boolean))
      );

      console.log("🧭 OperationalZone filter input", {
        rideId,
        rideOrigin: ride.origin,
        rideDestination: ride.destination,
        originRegion,
        destinationRegion,
        zoneNames,
        driversCountBefore: drivers.length,
        driverIdsBefore: drivers.slice(0, 20).map(d => d.id),
      });

      const zonedDriverIds = zoneNames.length > 0
        ? await prisma.driverOperationalZone.findMany({
            where: { zone: { name: { in: zoneNames } } },
            select: { driverId: true },
          })
        : [];

      console.log("🧩 OperationalZone zonedDriverIds", {
        rideId,
        zoneNames,
        count: zonedDriverIds.length,
        preview: zonedDriverIds.slice(0, 50).map(z => z.driverId),
      });

      let finalDrivers = drivers;
      let usedOperationalZoneFilter = false;
      if (zonedDriverIds.length > 0) {
        usedOperationalZoneFilter = true;
        const zonedDriverIdSet = new Set(zonedDriverIds.map(z => z.driverId));
        finalDrivers = drivers.filter(d => zonedDriverIdSet.has(d.id));
      } else {
        logMatchingEvent({
          rideId,
          event: "OPERATIONAL_ZONE_NOT_CONFIGURED",
          stage: "REFERRAL_NETWORK",
          metadata: { zoneNames, reason: "no_matching_driver_operational_zones" },
        });
      }

      console.log("✅ OperationalZone filter result", {
        rideId,
        usedOperationalZoneFilter,
        driversCountAfter: finalDrivers.length,
        driverIdsAfter: finalDrivers.slice(0, 20).map(d => d.id),
        firstMatchedDriverId: finalDrivers[0]?.id ?? null,
      });

      // Fallback: if no drivers match the operational zone filter, use all drivers
      // This ensures matching still works when OperationalZone data is not yet seeded
      const candidates = finalDrivers.length > 0 ? finalDrivers : drivers;

      if (candidates.length === 0) {
        // E6.2K.2A: authority separation — candidate-empty carries no
        // OWNER_RECOVERY authority (NO_MATCH_AVAILABLE => no owner transfer).
        logMatchingEvent({
          rideId,
          event: "matching_finished",
          stage: "GLOBAL",
          excludedDriverIds,
          resolvedRegion,
          metadata: { matched: false, recovery: true },
        });

        // TODO: Notify rootDriver

        return this.toResult("NO_MATCH_AVAILABLE", resultLevel, { reason: "no_candidates_after_zone_filter" });
      }

      const networkPick = candidates[0];
      const networkDispatchStage = stageByDriverId.get(networkPick.id) ?? dispatchStage;
      logMatchingEvent({
        rideId,
        event: "offers_prepared",
        stage: networkDispatchStage,
        candidateCount: candidates.length,
        previewCandidateIds: candidates.slice(0, 3).map((driver) => driver.id),
        excludedDriverIds,
        resolvedRegion,
      });

      const dispatchSingleResult = await this.dispatchSingle(
        rideId,
        networkPick.id,
        expiresAt,
        networkDispatchStage,
        candidates.length - 1
      );

      if (dispatchSingleResult.activeOfferExists) {
        return this.toResult("MATCHED", networkDispatchStage === "REFERRAL_NETWORK" ? resultLevel : "GENERAL", {
          offerId: dispatchSingleResult.activeOfferId,
          driverId: dispatchSingleResult.activeOfferDriverId,
        });
      }

      if (dispatchSingleResult.dispatched) {
        return this.toResult("MATCHED", networkDispatchStage === "REFERRAL_NETWORK" ? resultLevel : "GENERAL", {
          offerId: dispatchSingleResult.offerId,
          driverId: networkPick.id,
        });
      }

      return this.toResult("NO_MATCH_AVAILABLE", networkDispatchStage === "REFERRAL_NETWORK" ? resultLevel : "GENERAL", { reason: "dispatch_single_failed_no_active_offer" });
    }

    // Non-referred rides may expose MATCHING briefly while the initial search
    // is being assembled. A concrete offer immediately replaces it with the
    // corresponding WAITING_GENERAL UX state.
    if (!dispatchRootDriverId && ride.status === "PENDING") {
      await prisma.rideRequest.updateMany({
        where: { id: rideId, status: "PENDING" },
        data: { status: "MATCHING", currentDispatchStage: "NETWORK_DISPATCH" },
      });
    }

    const { drivers: generalDrivers, resolvedRegion, dispatchStage } = await this.preparePriorityDrivers(
      rideId,
      ride.origin,
      "GENERAL",
      dispatchRootDriverId,
      alreadyOfferedIds,
      excludedDriverIds,
      rideContext,
      candidateDriverIds,
    );

    if (generalDrivers.length === 0) {
      // E6.2K.2A: authority separation — see NETWORK candidate-empty above.
      logMatchingEvent({
        rideId,
        event: "matching_finished",
        stage: "GLOBAL",
        excludedDriverIds,
        resolvedRegion,
        metadata: { matched: false, startLevel: level },
      });
      return this.toResult("NO_MATCH_AVAILABLE", "GENERAL", { reason: "no_candidates_in_general_pool" });
    }

    const generalPick = generalDrivers[0];
    logMatchingEvent({
      rideId,
      event: "offers_prepared",
      stage: dispatchStage,
      candidateCount: generalDrivers.length,
      previewCandidateIds: generalDrivers.slice(0, 3).map((driver) => driver.id),
      excludedDriverIds,
      resolvedRegion,
    });

    const dispatchSingleResult = await this.dispatchSingle(
      rideId,
      generalPick.id,
      expiresAt,
      dispatchStage,
      generalDrivers.length - 1
    );

    if (dispatchSingleResult.activeOfferExists) {
      return this.toResult("MATCHED", "GENERAL", {
        offerId: dispatchSingleResult.activeOfferId,
        driverId: dispatchSingleResult.activeOfferDriverId,
      });
    }

    if (dispatchSingleResult.dispatched) {
      return this.toResult("MATCHED", "GENERAL", {
        offerId: dispatchSingleResult.offerId,
        driverId: generalPick.id,
      });
    }

    return this.toResult("NO_MATCH_AVAILABLE", "GENERAL", { reason: "dispatch_single_failed_no_active_offer" });
  }

  private toResult(
    outcome: MatchRideOutcome,
    level: MatchLevel,
    extra?: { offerId?: string; driverId?: string; reason?: string }
  ): MatchRideResult {
    const result: MatchRideResult = {
      outcome,
      level,
      matched: outcome === "MATCHED",
      ...extra,
    };
    if (outcome === "MATCHED" && !result.offerId) {
      console.warn(`[MatchRideUseCase] MATCHED outcome without offerId — this indicates a logic gap`);
    }
    return result;
  }
}
