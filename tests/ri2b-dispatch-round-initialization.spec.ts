import fs from "node:fs";
import path from "node:path";

const transaction = jest.fn();

jest.mock("../src/infra/prisma/client", () => ({
  prisma: { $transaction: transaction },
}));

import {
  DispatchRoundInitializationError,
  initializeDispatchRound,
} from "../src/application/services/InitializeDispatchRoundService";

type FakeTx = {
  demandRevision: { findMany: jest.Mock; findUnique: jest.Mock };
  dispatchRound: {
    findFirst: jest.Mock;
    aggregate: jest.Mock;
    create: jest.Mock;
  };
  $queryRaw: jest.Mock;
};

function makeTx(): FakeTx {
  return {
    demandRevision: { findMany: jest.fn(), findUnique: jest.fn() },
    dispatchRound: {
      findFirst: jest.fn(),
      aggregate: jest.fn(),
      create: jest.fn(),
    },
    $queryRaw: jest.fn(),
  };
}

describe("RI2B DispatchRound initialization", () => {
  beforeEach(() => transaction.mockReset());

  test("creates an ACTIVE round for the single CURRENT revision", async () => {
    const boundary = new Date("2026-09-22T12:00:00.000Z");
    const tx = makeTx();
    tx.demandRevision.findMany.mockResolvedValue([{ id: "revision-1", state: "CURRENT" }]);
    tx.demandRevision.findUnique.mockResolvedValue({
      id: "revision-1",
      rideRequestId: "ride-1",
      state: "CURRENT",
    });
    tx.dispatchRound.findFirst.mockResolvedValue(null);
    tx.dispatchRound.aggregate.mockResolvedValue({ _max: { sequence: null } });
    tx.dispatchRound.create.mockResolvedValue({
      id: "round-1",
      sequence: 1,
      candidateUniverseBoundaryAt: boundary,
    });
    transaction.mockImplementation(async (callback: (tx: FakeTx) => unknown) => callback(tx));

    await expect(initializeDispatchRound("ride-1", boundary)).resolves.toMatchObject({
      currentRevisionId: "revision-1",
      dispatchRoundId: "round-1",
      sequence: 1,
      candidateUniverseBoundaryAt: boundary,
      created: true,
    });
    expect(tx.dispatchRound.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        demandRevisionId: "revision-1",
        sequence: 1,
        state: "ACTIVE",
        candidateUniverseBoundaryAt: boundary,
        startedAt: boundary,
        fenceVersion: 0,
      }),
    });
  });

  test("reuses an existing ACTIVE round instead of creating another", async () => {
    const boundary = new Date("2026-09-22T12:00:00.000Z");
    const tx = makeTx();
    tx.demandRevision.findMany.mockResolvedValue([{ id: "revision-1", state: "CURRENT" }]);
    tx.demandRevision.findUnique.mockResolvedValue({
      id: "revision-1",
      rideRequestId: "ride-1",
      state: "CURRENT",
    });
    tx.dispatchRound.findFirst.mockResolvedValue({
      id: "round-existing",
      sequence: 2,
      candidateUniverseBoundaryAt: boundary,
    });
    transaction.mockImplementation(async (callback: (tx: FakeTx) => unknown) => callback(tx));

    const result = await initializeDispatchRound("ride-1", boundary);

    expect(result.created).toBe(false);
    expect(result.dispatchRoundId).toBe("round-existing");
    expect(tx.dispatchRound.create).not.toHaveBeenCalled();
    expect(tx.dispatchRound.aggregate).not.toHaveBeenCalled();
  });

  test("allocates the next sequence within the DemandRevision", async () => {
    const tx = makeTx();
    tx.demandRevision.findMany.mockResolvedValue([{ id: "revision-1", state: "CURRENT" }]);
    tx.demandRevision.findUnique.mockResolvedValue({
      id: "revision-1",
      rideRequestId: "ride-1",
      state: "CURRENT",
    });
    tx.dispatchRound.findFirst.mockResolvedValue(null);
    tx.dispatchRound.aggregate.mockResolvedValue({ _max: { sequence: 4 } });
    tx.dispatchRound.create.mockResolvedValue({
      id: "round-5",
      sequence: 5,
      candidateUniverseBoundaryAt: new Date(),
    });
    transaction.mockImplementation(async (callback: (tx: FakeTx) => unknown) => callback(tx));

    await initializeDispatchRound("ride-1");

    expect(tx.dispatchRound.aggregate).toHaveBeenCalledWith({
      where: { demandRevisionId: "revision-1" },
      _max: { sequence: true },
    });
    expect(tx.dispatchRound.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sequence: 5 }),
    });
  });

  test("fails closed when no CURRENT revision exists", async () => {
    const tx = makeTx();
    tx.demandRevision.findMany.mockResolvedValue([]);
    transaction.mockImplementation(async (callback: (tx: FakeTx) => unknown) => callback(tx));

    await expect(initializeDispatchRound("ride-1")).rejects.toBeInstanceOf(
      DispatchRoundInitializationError,
    );
    expect(tx.dispatchRound.create).not.toHaveBeenCalled();
  });

  test("fails closed when multiple CURRENT revisions exist", async () => {
    const tx = makeTx();
    tx.demandRevision.findMany.mockResolvedValue([{ id: "revision-1" }, { id: "revision-2" }]);
    transaction.mockImplementation(async (callback: (tx: FakeTx) => unknown) => callback(tx));

    await expect(initializeDispatchRound("ride-1")).rejects.toBeInstanceOf(
      DispatchRoundInitializationError,
    );
    expect(tx.dispatchRound.create).not.toHaveBeenCalled();
  });

  test("locks the revision before checking or allocating a round", async () => {
    const tx = makeTx();
    const callOrder: string[] = [];
    tx.demandRevision.findMany.mockImplementation(async () => {
      callOrder.push("revision");
      return [{ id: "revision-1", state: "CURRENT" }];
    });
    tx.demandRevision.findUnique.mockImplementation(async () => {
      callOrder.push("revalidate");
      return { id: "revision-1", rideRequestId: "ride-1", state: "CURRENT" };
    });
    tx.$queryRaw.mockImplementation(async () => {
      callOrder.push("lock");
      return [];
    });
    tx.dispatchRound.findFirst.mockImplementation(async () => {
      callOrder.push("active");
      return { id: "round-1", sequence: 1, candidateUniverseBoundaryAt: new Date() };
    });
    transaction.mockImplementation(async (callback: (tx: FakeTx) => unknown) => callback(tx));

    await initializeDispatchRound("ride-1");

    expect(callOrder).toEqual(["revision", "lock", "revalidate", "active"]);
  });

  test("fails closed when the locked revision is no longer CURRENT", async () => {
    const tx = makeTx();
    tx.demandRevision.findMany.mockResolvedValue([{ id: "revision-1", state: "CURRENT" }]);
    tx.demandRevision.findUnique.mockResolvedValue({
      id: "revision-1",
      rideRequestId: "ride-1",
      state: "SUPERSEDED",
    });
    transaction.mockImplementation(async (callback: (tx: FakeTx) => unknown) => callback(tx));

    await expect(initializeDispatchRound("ride-1")).rejects.toBeInstanceOf(
      DispatchRoundInitializationError,
    );
    expect(tx.dispatchRound.findFirst).not.toHaveBeenCalled();
    expect(tx.dispatchRound.create).not.toHaveBeenCalled();
  });

  test("uses the revision row lock as the normal concurrency authority", async () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/application/services/InitializeDispatchRoundService.ts"),
      "utf8",
    );

    expect(source).toContain("FOR UPDATE");
    expect(source).toContain("TransactionIsolationLevel.ReadCommitted");
    expect(source).not.toContain("catch (unique");
    expect(source).not.toContain("P2002");
  });

  test("initializes only the round and does not create candidates or offers", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/application/services/InitializeDispatchRoundService.ts"),
      "utf8",
    );

    expect(source).toContain("dispatchRound.create");
    expect(source).not.toContain("dispatchRoundCandidate.create");
    expect(source).not.toContain("rideOffer.create");
  });

  test("uses one persisted boundary and does not recompute it per scope", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/application/services/InitializeDispatchRoundService.ts"),
      "utf8",
    );

    expect(source.match(/candidateUniverseBoundaryAt/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).not.toContain("scope");
  });

  test("initial lifecycle fields are ACTIVE with null terminal fields by schema defaults", () => {
    const schema = fs.readFileSync(
      path.resolve(__dirname, "../prisma/schema.prisma"),
      "utf8",
    );
    const roundBlock = schema.slice(schema.indexOf("model DispatchRound {"), schema.indexOf("model DispatchRoundCandidate {"));

    expect(roundBlock).toContain("state                       DispatchRoundState           @default(ACTIVE)");
    expect(roundBlock).toMatch(/completedAt\s+DateTime\?/);
    expect(roundBlock).toContain("terminalReason              DispatchRoundTerminalReason?");
  });

  test("integration initializes the round before candidate discovery", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/application/use-cases/MatchRideUseCase.ts"),
      "utf8",
    );
    const roundInitialization = source.indexOf("await initializeDispatchRound(rideId);");
    const levelDerivation = source.indexOf("const level = input.level");
    const priorityDiscovery = source.indexOf("} = await this.preparePriorityDrivers(", roundInitialization);
    const dispatch = source.indexOf("this.dispatchSingle(");

    expect(roundInitialization).toBeGreaterThan(-1);
    expect(roundInitialization).toBeLessThan(levelDerivation);
    expect(roundInitialization).toBeLessThan(priorityDiscovery);
    expect(roundInitialization).toBeLessThan(dispatch);
  });
});
