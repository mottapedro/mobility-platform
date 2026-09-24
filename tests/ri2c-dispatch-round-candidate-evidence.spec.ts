import fs from "node:fs";
import path from "node:path";
import { materializeDispatchRoundCandidates } from "../src/application/services/MaterializeDispatchRoundCandidatesService";

type FakeDatabase = {
  dispatchRoundCandidate: {
    createMany: jest.Mock;
  };
};

describe("RI2C DispatchRoundCandidate evidence", () => {
  const boundary = new Date("2026-09-23T12:00:00.000Z");

  function db(): FakeDatabase {
    return {
      dispatchRoundCandidate: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
  }

  test("materializes OPEN/NONE evidence for the owning round", async () => {
    const database = db();

    await materializeDispatchRoundCandidates({
      dispatchRoundId: "round-1",
      candidateUniverseBoundaryAt: boundary,
      candidates: [{ driverId: "driver-1", scopeKey: "REGION" }],
    }, { db: database });

    expect(database.dispatchRoundCandidate.createMany).toHaveBeenCalledWith({
      data: [{
        dispatchRoundId: "round-1",
        driverId: "driver-1",
        scopeKey: "REGION",
        eligibleAtBoundary: boundary,
        boundarySource: "DispatchRound.candidateUniverseBoundaryAt",
        accountingDisposition: "OPEN",
        offerObservation: "NONE",
      }],
      skipDuplicates: true,
    });
  });

  test("normalizes duplicate drivers and preserves existing rows through skipDuplicates", async () => {
    const database = db();

    await materializeDispatchRoundCandidates({
      dispatchRoundId: "round-1",
      candidateUniverseBoundaryAt: boundary,
      candidates: [
        { driverId: "driver-1", scopeKey: "NETWORK_L1" },
        { driverId: "driver-1", scopeKey: "REGION" },
        { driverId: "driver-2", scopeKey: "GLOBAL" },
      ],
    }, { db: database });

    const [[{ data, skipDuplicates }]] = database.dispatchRoundCandidate.createMany.mock.calls;
    expect(data).toHaveLength(2);
    expect(data.map((candidate: { driverId: string }) => candidate.driverId)).toEqual(["driver-1", "driver-2"]);
    expect(skipDuplicates).toBe(true);
  });

  test("allows the same driver in independent rounds", async () => {
    const database = db();

    await materializeDispatchRoundCandidates({
      dispatchRoundId: "round-1",
      candidateUniverseBoundaryAt: boundary,
      candidates: [{ driverId: "driver-1", scopeKey: "GENERAL" }],
    }, { db: database });
    await materializeDispatchRoundCandidates({
      dispatchRoundId: "round-2",
      candidateUniverseBoundaryAt: boundary,
      candidates: [{ driverId: "driver-1", scopeKey: "GENERAL" }],
    }, { db: database });

    expect(database.dispatchRoundCandidate.createMany).toHaveBeenCalledTimes(2);
    expect(database.dispatchRoundCandidate.createMany.mock.calls[0][0].data[0].dispatchRoundId).toBe("round-1");
    expect(database.dispatchRoundCandidate.createMany.mock.calls[1][0].data[0].dispatchRoundId).toBe("round-2");
  });

  test("does nothing for an empty universe", async () => {
    const database = db();

    await materializeDispatchRoundCandidates({
      dispatchRoundId: "round-empty",
      candidateUniverseBoundaryAt: boundary,
      candidates: [],
    }, { db: database });

    expect(database.dispatchRoundCandidate.createMany).not.toHaveBeenCalled();
  });

  test("keeps the boundary and evidence before offer creation in the runtime seam", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/application/use-cases/MatchRideUseCase.ts"),
      "utf8",
    );
    expect(source).toContain("candidateUniverseBoundaryAt: dispatchRound.candidateUniverseBoundaryAt");
    expect(source.indexOf("materializeDispatchRoundCandidates")).toBeLessThan(source.indexOf("this.dispatchSingle("));
    expect(source).not.toContain("dispatchRoundId: result.offer");
  });
});
