/// <reference types="jest" />
/**
 * Schema Contract Suite — DMMF-driven drift detector.
 *
 * Purpose: prove that the Prisma client, the generated TypeScript types, and
 * the live PostgreSQL schema agree on every scalar/enum column of every
 * model. Catches `P2022 ColumnNotFound` and `P2021 TableNotFound` before any
 * business test runs.
 *
 * Scope (intentional):
 *   ✓ scalar fields (including FK scalars like driverId, rideRequestId)
 *   ✓ enum fields
 *   ✗ relation accessors (kind === "object") — they do not map to DB columns
 *
 * This suite is auto-scaling: adding a model or column to schema.prisma and
 * regenerating the client extends the contract automatically — no per-model
 * spec to write or maintain.
 *
 * Failure modes intentionally surfaced:
 *   - column rename without code update    → P2022
 *   - table drop without code update       → P2021
 *   - migration not deployed               → P2022 / P2021 on the affected model
 *   - prisma generate skipped after edit   → type-level error caught by tsc
 *
 * Runs in <3s on a warm DB. Do NOT add fixtures or business assertions here —
 * those belong in domain specs.
 */
import { Prisma } from "@prisma/client";
import { prisma, disconnectPrisma } from "../../src/infra/prisma/client";

afterAll(async () => {
  await disconnectPrisma();
});

type Field = Prisma.DMMF.Field;
type Model = Prisma.DMMF.Model;

const models: readonly Model[] = Prisma.dmmf.datamodel.models;

function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function scalarAndEnumSelect(model: Model): Record<string, true> {
  return model.fields
    .filter((f: Field) => f.kind === "scalar" || f.kind === "enum")
    .reduce<Record<string, true>>((acc, f) => {
      acc[f.name] = true;
      return acc;
    }, {});
}

describe("Schema Contract — every scalar/enum column exists in the database", () => {
  it("DMMF returns at least one model (sanity)", () => {
    expect(models.length).toBeGreaterThan(0);
  });

  it.each(models.map((m) => [m.name, m] as const))(
    "%s: all scalar/enum columns selectable",
    async (_name, model) => {
      const select = scalarAndEnumSelect(model);
      const accessor = lowerFirst(model.name);
      // Dynamic delegate access mirrors Prisma client shape; the runtime
      // query is the actual contract assertion — types are best-effort here.
      const delegate = (prisma as unknown as Record<string, { findFirst: (args: { select: Record<string, true> }) => Promise<unknown> }>)[accessor];
      expect(delegate).toBeDefined();
      // findFirst with select-only will throw P2022 if any selected column
      // is missing from the database, regardless of whether rows exist.
      await delegate.findFirst({ select });
    }
  );
});
