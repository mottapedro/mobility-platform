import { ActorType, ReferralFlowType } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";
import { listRelationshipsForRoot } from "./ReferralRelationshipService";

export interface NetworkRelationshipDTO {
  id: string;
  flowType: ReferralFlowType;
  inviter: { actorType: ActorType; id: string };
  invited: { actorType: ActorType; id: string };
  rootDriverId: string;
  createdAt: Date;
}

export interface NetworkRelationshipsResponse {
  driverId: string;
  totals: {
    total: number;
    driverToDriver: number;
    driverToPassenger: number;
    passengerToPassenger: number;
  };
  relationships: NetworkRelationshipDTO[];
}

export async function getNetworkRelationships(
  rootDriverId: string,
  options: { flowType?: ReferralFlowType } = {}
): Promise<NetworkRelationshipsResponse> {
  const rows = await listRelationshipsForRoot(rootDriverId, options, prisma);
  const dtos: NetworkRelationshipDTO[] = rows.map((r) => ({
    id: r.id,
    flowType: r.flowType,
    inviter: { actorType: r.inviterActorType, id: r.inviterId },
    invited: { actorType: r.invitedActorType, id: r.invitedId },
    rootDriverId: r.rootDriverId,
    createdAt: r.createdAt,
  }));

  return {
    driverId: rootDriverId,
    totals: {
      total: dtos.length,
      driverToDriver: dtos.filter(
        (d) => d.flowType === ReferralFlowType.DRIVER_TO_DRIVER
      ).length,
      driverToPassenger: dtos.filter(
        (d) => d.flowType === ReferralFlowType.DRIVER_TO_PASSENGER
      ).length,
      passengerToPassenger: dtos.filter(
        (d) => d.flowType === ReferralFlowType.PASSENGER_TO_PASSENGER
      ).length,
    },
    relationships: dtos,
  };
}
