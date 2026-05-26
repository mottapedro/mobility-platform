/**
 * Application Service: ResolveRootDriverService
 *
 * Stage 2.B leaf service. Promotes the pure domain function
 * `resolveDriverRoot` into the application layer so orchestrators can:
 *   - depend on a stable `execute({ actorType, actorId }, deps?)` shape;
 *   - opt-in to emit a `LINEAGE_RESOLVED` DomainEvent for downstream
 *     projections (NetworkOwnership, GodNetwork conformance, audit log);
 *   - inject a sliced `Db` for transactional composition.
 *
 * Behavior preserved from the domain function — no new resolution rules.
 */

import { ActorType, DomainEventType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { resolveDriverRoot } from "../../domain/referral-network/DriverRootResolverService";
import { EventBus, recordAndPublish } from "../../domain/shared/events/EventBus";

type Db = Pick<
  typeof prisma,
  "driver" | "driverReferral" | "passenger" | "referralRelationship" | "domainEvent"
>;

export interface ResolveRootDriverInput {
  actorType: ActorType;
  actorId: string;
}

export interface ResolveRootDriverResult {
  actorType: ActorType;
  actorId: string;
  rootDriverId: string | null;
}

export interface ResolveRootDriverDeps {
  db?: Db;
  bus?: EventBus;
}

export async function execute(
  input: ResolveRootDriverInput,
  deps: ResolveRootDriverDeps = {}
): Promise<ResolveRootDriverResult> {
  const db = deps.db ?? prisma;
  const rootDriverId = await resolveDriverRoot(input.actorType, input.actorId, db);

  if (deps.bus) {
    await recordAndPublish(
      deps.bus,
      {
        type: DomainEventType.LINEAGE_RESOLVED,
        aggregateType: input.actorType === ActorType.DRIVER ? "Driver" : "Passenger",
        aggregateId: input.actorId,
        payload: {
          actorType: input.actorType,
          actorId: input.actorId,
          rootDriverId,
        },
      },
      db
    );
  }

  return {
    actorType: input.actorType,
    actorId: input.actorId,
    rootDriverId,
  };
}

export const ResolveRootDriverService = { execute };
