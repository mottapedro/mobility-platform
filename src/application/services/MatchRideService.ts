/**
 * Application Service: MatchRideService
 *
 * Stage 2.B shell coordinator. Provides the stable application-layer entry
 * point for matching a ride to a driver. Internally delegates to the existing
 * MatchRideUseCase so that current call sites and behavior are preserved
 * byte-for-byte; the value of this layer is:
 *
 *   1. Centralizes the matching surface so controllers, ExpireOffersService,
 *      RespondToRideOfferUseCase, and future orchestrators (PixPaymentOrchestrator,
 *      RideExecutionService) all depend on a single coordinator.
 *   2. Establishes the `{ db?, bus? }` deps contract used by every other
 *      Stage 2.B service, so DomainEvent emission (MATCH_STARTED / MATCH_FINISHED
 *      / MATCH_EXPANDED) can be plugged in PR-5 without touching call sites.
 *   3. Documents the operational responsibility split: this service owns
 *      matching orchestration, NOT offer persistence (CreateOfferService),
 *      payment (PixPaymentOrchestrator), settlement (ConfirmPixSettlementService),
 *      or rewards (RewardDistributionService).
 *
 * NOTE: this service intentionally does NOT emit DomainEvents yet because
 * MATCH_STARTED / MATCH_FINISHED / MATCH_EXPANDED are not present in the
 * DomainEventType enum. Adding them is a PR-5 concern (requires a new
 * Prisma migration).
 */

import { prisma } from "../../infra/prisma/client";
import type { EventBus } from "../../domain/shared/events/EventBus";
import {
  MatchInput,
  MatchLevel,
  MatchRideOutcome,
  MatchRideResult,
  MatchRideUseCase,
} from "../use-cases/MatchRideUseCase";

type Db = Pick<typeof prisma, "rideRequest" | "rideOffer" | "domainEvent">;

export interface MatchRideDeps {
  db?: Db;
  bus?: EventBus;
}

export async function execute(
  input: MatchInput,
  _deps: MatchRideDeps = {}
): Promise<MatchRideResult> {
  // `_deps` is reserved for forward compatibility (event bus, alternate db
  // slice). The underlying use-case currently reads `prisma` directly; once
  // PR-5 introduces MATCH_* DomainEventType values and threads `db` through
  // the use-case, this shell becomes the bus injection point.
  const useCase = new MatchRideUseCase();
  return useCase.execute(input);
}

export const MatchRideService = { execute };
