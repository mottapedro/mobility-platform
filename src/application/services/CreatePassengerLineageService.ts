/**
 * Application Service: CreatePassengerLineageService
 *
 * Stage 2.B leaf service. Establishes a passenger's place in the Aliado
 * referral graph in a single application-level call:
 *
 *   1. Records the inviter → invited PASSENGER ReferralRelationship
 *      (idempotent via the underlying domain service).
 *   2. Walks the resulting graph to materialize the full PassengerLineage.
 *   3. Optionally emits a `LINEAGE_RESOLVED` DomainEvent for downstream
 *      projections (NetworkOwnership / GodNetwork conformance / audit).
 *
 * Behavior of the underlying domain layer is preserved unchanged.
 */

import type { ReferralRelationship } from "@prisma/client";
import { ActorType, DomainEventType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { recordRelationship } from "../../domain/referral-network/ReferralRelationshipService";
import {
  getPassengerLineage,
  PassengerLineage,
} from "../../domain/referral-network/PassengerLineageService";
import { EventBus, recordAndPublish } from "../../domain/shared/events/EventBus";

type Db = Pick<
  typeof prisma,
  | "driver"
  | "driverReferral"
  | "passenger"
  | "referralRelationship"
  | "domainEvent"
>;

export interface CreatePassengerLineageInput {
  inviterActorType: ActorType;
  inviterId: string;
  invitedPassengerId: string;
}

export interface CreatePassengerLineageResult {
  relationship: ReferralRelationship;
  lineage: PassengerLineage;
}

export interface CreatePassengerLineageDeps {
  db?: Db;
  bus?: EventBus;
}

export async function execute(
  input: CreatePassengerLineageInput,
  deps: CreatePassengerLineageDeps = {}
): Promise<CreatePassengerLineageResult> {
  const db = deps.db ?? prisma;

  const relationship = await recordRelationship(
    {
      inviterActorType: input.inviterActorType,
      inviterId: input.inviterId,
      invitedActorType: ActorType.PASSENGER,
      invitedId: input.invitedPassengerId,
    },
    db
  );

  const lineage = await getPassengerLineage(input.invitedPassengerId, db);

  if (deps.bus) {
    await recordAndPublish(
      deps.bus,
      {
        type: DomainEventType.LINEAGE_RESOLVED,
        aggregateType: "Passenger",
        aggregateId: input.invitedPassengerId,
        payload: {
          passengerId: input.invitedPassengerId,
          rootDriverId: lineage.rootDriverId,
          flowType: lineage.flowType,
          ancestorCount: lineage.ancestors.length,
        },
      },
      db
    );
  }

  return { relationship, lineage };
}

export const CreatePassengerLineageService = { execute };
