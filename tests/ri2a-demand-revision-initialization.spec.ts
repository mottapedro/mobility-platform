import fs from "node:fs";
import path from "node:path";

const controllerPath = path.resolve(
  __dirname,
  "../src/presentation/controllers/ride.controller.ts",
);
const schemaPath = path.resolve(__dirname, "../prisma/schema.prisma");

const controllerSource = fs.readFileSync(controllerPath, "utf8");
const schemaSource = fs.readFileSync(schemaPath, "utf8");

describe("RI2A initial demand revision contract", () => {
  test("creates sequence 1 from the created RideRequest in the existing transaction", () => {
    const transactionStart = controllerSource.indexOf(
      "prisma.$transaction(async (tx) => {",
    );
    const rideRequestCreate = controllerSource.indexOf(
      "const created = await tx.rideRequest.create({",
      transactionStart,
    );
    const revisionCreate = controllerSource.indexOf(
      "await tx.demandRevision.create({",
      rideRequestCreate,
    );
    const ownershipSnapshotCreate = controllerSource.indexOf(
      "await tx.ownershipSnapshot.create({",
      revisionCreate,
    );

    expect(transactionStart).toBeGreaterThanOrEqual(0);
    expect(rideRequestCreate).toBeGreaterThan(transactionStart);
    expect(revisionCreate).toBeGreaterThan(rideRequestCreate);
    expect(ownershipSnapshotCreate).toBeGreaterThan(revisionCreate);

    const revisionBlock = controllerSource.slice(
      revisionCreate,
      ownershipSnapshotCreate,
    );
    expect(revisionBlock).toContain("rideRequestId: created.id");
    expect(revisionBlock).toContain("sequence: 1");
    expect(revisionBlock).toContain('state: "CURRENT"');
    expect(revisionBlock).toContain("origin: created.origin");
    expect(revisionBlock).toContain("destination: created.destination");
    expect(revisionBlock).toContain("scheduledAt: created.scheduledAt");
    expect(revisionBlock).toContain("originPlaceId: created.originPlaceId");
    expect(revisionBlock).toContain(
      "destinationPlaceId: created.destinationPlaceId",
    );
  });

  test("keeps initial revision persistence inside the transaction without a compensating path", () => {
    const transactionStart = controllerSource.indexOf(
      "prisma.$transaction(async (tx) => {",
    );
    const transactionEnd = controllerSource.indexOf(
      "});",
      controllerSource.indexOf("await tx.ownershipSnapshot.create({", transactionStart),
    );
    const transactionBlock = controllerSource.slice(
      transactionStart,
      transactionEnd,
    );

    expect(transactionBlock).toContain("await tx.demandRevision.create({");
    expect(transactionBlock).not.toContain("catch");
    expect(transactionBlock).not.toContain("prisma.demandRevision.create");
    expect(
      (transactionBlock.match(/demandRevision\.create\(/g) ?? []).length,
    ).toBe(1);
  });

  test("relies on the schema uniqueness contract for one sequence 1 per request", () => {
    expect(schemaSource).toContain("model DemandRevision {");
    expect(schemaSource).toContain("@@unique([rideRequestId, sequence])");
  });
});
