type CandidateEvidenceDb = {
  dispatchRoundCandidate: {
    createMany(args: {
      data: Array<{
        dispatchRoundId: string;
        driverId: string;
        scopeKey: string;
        eligibleAtBoundary: Date;
        boundarySource: string;
        accountingDisposition: "OPEN";
        offerObservation: "NONE";
      }>;
      skipDuplicates: boolean;
    }): Promise<unknown>;
  };
};

export interface MaterializeDispatchRoundCandidatesInput {
  dispatchRoundId: string;
  candidateUniverseBoundaryAt: Date;
  candidates: ReadonlyArray<{ driverId: string; scopeKey: string }>;
}

export interface MaterializeDispatchRoundCandidatesDeps {
  db: CandidateEvidenceDb;
}

export async function materializeDispatchRoundCandidates(
  input: MaterializeDispatchRoundCandidatesInput,
  deps: MaterializeDispatchRoundCandidatesDeps,
): Promise<void> {
  const { db } = deps;
  const uniqueCandidates = new Map<string, { driverId: string; scopeKey: string }>();

  for (const candidate of input.candidates) {
    if (!uniqueCandidates.has(candidate.driverId)) {
      uniqueCandidates.set(candidate.driverId, candidate);
    }
  }

  if (uniqueCandidates.size === 0) return;

  await db.dispatchRoundCandidate.createMany({
    data: [...uniqueCandidates.values()].map((candidate) => ({
      dispatchRoundId: input.dispatchRoundId,
      driverId: candidate.driverId,
      scopeKey: candidate.scopeKey,
      eligibleAtBoundary: input.candidateUniverseBoundaryAt,
      boundarySource: "DispatchRound.candidateUniverseBoundaryAt",
      accountingDisposition: "OPEN",
      offerObservation: "NONE",
    })),
    skipDuplicates: true,
  });
}

export const MaterializeDispatchRoundCandidatesService = {
  execute: materializeDispatchRoundCandidates,
};
