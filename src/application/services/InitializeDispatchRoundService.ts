import { Prisma } from "@prisma/client";
import { prisma } from "../../infra/prisma/client";

export class DispatchRoundInitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchRoundInitializationError";
  }
}

export interface DispatchRoundInitializationResult {
  currentRevisionId: string;
  dispatchRoundId: string;
  sequence: number;
  candidateUniverseBoundaryAt: Date;
  created: boolean;
}

/** Establishes the first dispatch round before candidate discovery. */
export async function initializeDispatchRound(
  rideRequestId: string,
  boundaryAt = new Date(),
): Promise<DispatchRoundInitializationResult> {
  return prisma.$transaction(async (tx) => {
    const currentRevisions = await tx.demandRevision.findMany({
      where: { rideRequestId, state: "CURRENT" },
      orderBy: { sequence: "asc" },
    });

    if (currentRevisions.length === 0) {
      throw new DispatchRoundInitializationError(
        `Ride ${rideRequestId} has no CURRENT DemandRevision`,
      );
    }

    if (currentRevisions.length > 1) {
      throw new DispatchRoundInitializationError(
        `Ride ${rideRequestId} has multiple CURRENT DemandRevisions`,
      );
    }

    const currentRevision = currentRevisions[0];

    // Serialize allocation per revision. The unique ACTIVE constraint remains
    // the final database guard against an ungoverned concurrent writer.
    await tx.$queryRaw`
      SELECT "id"
      FROM "DemandRevision"
      WHERE "id" = ${currentRevision.id}
      FOR UPDATE
    `;

    const lockedRevision = await tx.demandRevision.findUnique({
      where: { id: currentRevision.id },
      select: { id: true, rideRequestId: true, state: true },
    });

    if (
      !lockedRevision ||
      lockedRevision.rideRequestId !== rideRequestId ||
      lockedRevision.state !== "CURRENT"
    ) {
      throw new DispatchRoundInitializationError(
        `Ride ${rideRequestId} no longer has the resolved CURRENT DemandRevision`,
      );
    }

    const activeRound = await tx.dispatchRound.findFirst({
      where: { demandRevisionId: currentRevision.id, state: "ACTIVE" },
      orderBy: { sequence: "desc" },
    });

    if (activeRound) {
      return {
        currentRevisionId: currentRevision.id,
        dispatchRoundId: activeRound.id,
        sequence: activeRound.sequence,
        candidateUniverseBoundaryAt: activeRound.candidateUniverseBoundaryAt,
        created: false,
      };
    }

    const sequenceResult = await tx.dispatchRound.aggregate({
      where: { demandRevisionId: currentRevision.id },
      _max: { sequence: true },
    });
    const sequence = (sequenceResult._max.sequence ?? 0) + 1;

    const round = await tx.dispatchRound.create({
      data: {
        demandRevisionId: currentRevision.id,
        sequence,
        state: "ACTIVE",
        candidateUniverseBoundaryAt: boundaryAt,
        startedAt: boundaryAt,
        fenceVersion: 0,
      },
    });

    return {
      currentRevisionId: currentRevision.id,
      dispatchRoundId: round.id,
      sequence: round.sequence,
      candidateUniverseBoundaryAt: round.candidateUniverseBoundaryAt,
      created: true,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
