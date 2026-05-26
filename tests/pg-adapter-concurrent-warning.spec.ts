/**
 * Regression guard: pg DeprecationWarning "Calling client.query() when the
 * client is already executing a query" inside Prisma transactions.
 *
 * Root cause: Prisma's query-interpreter runs relation sub-queries via
 * Array.map (parallel) inside a transaction, hitting the same pg PoolClient
 * concurrently. pg@8.x warns when _queryQueue.length > 0 at the time a new
 * query() call arrives on the same connection.
 *
 * Fix: Wrap each PoolClient returned by pool.connect() with a promise-chain
 * serializer so concurrent query() invocations are sequenced before they
 * reach the pg.Client, keeping _queryQueue.length === 0 at call time.
 *
 * Detection strategy: process.on('warning', handler) captures warning events.
 * process.emitWarning() is NOT directly spy-able (non-configurable property),
 * so we use the event listener API instead.
 *
 * NOTE on deduplication: util.deprecate() emits the warning only ONCE per
 * process lifetime (per function reference). If another test suite runs first
 * and triggers the warning, this spec always passes (false-positive). For a
 * definitive check run this file alone:
 *   npx jest tests/pg-adapter-concurrent-warning.spec.ts --runInBand
 */
import { pool } from "../src/infra/prisma/client";
import { prisma } from "./setup";

const CONCURRENT_MSG =
  "Calling client.query() when the client is already executing a query";

/** Let any pending process.nextTick() calls (used by process.emitWarning) drain. */
const drainNextTick = () => new Promise<void>((r) => setImmediate(r));

describe("pg PoolClient serializer — no concurrent-query DeprecationWarning", () => {
  let capturedWarnings: string[];
  let warningHandler: (w: Error & { code?: string }) => void;

  beforeEach(() => {
    capturedWarnings = [];
    warningHandler = (w: Error & { code?: string }) => {
      if (typeof w.message === "string") {
        capturedWarnings.push(w.message);
      }
    };
    process.on("warning", warningHandler);
  });

  afterEach(() => {
    process.off("warning", warningHandler);
  });

  it("does not warn when two queries are submitted concurrently on the same connection", async () => {
    const conn = await pool.connect();
    try {
      // Both queries start before either resolves — this is the pattern that
      // triggers pg's DeprecationWarning without the serializer.
      await Promise.all([conn.query("SELECT 1"), conn.query("SELECT 1")]);
    } finally {
      conn.release();
    }

    // Allow process.emitWarning()'s nextTick to fire before asserting.
    await drainNextTick();

    const concurrentWarnings = capturedWarnings.filter((m) =>
      m.includes(CONCURRENT_MSG)
    );
    expect(concurrentWarnings).toHaveLength(0);
  });

  it("completes a transaction with a relation read without emitting the warning", async () => {
    await prisma.$transaction(async (tx) => {
      return tx.driver.findMany({
        where: { isActive: true },
        select: { id: true, vehicles: { select: { category: true } } },
        take: 3,
      });
    });

    await drainNextTick();

    const concurrentWarnings = capturedWarnings.filter((m) =>
      m.includes(CONCURRENT_MSG)
    );
    expect(concurrentWarnings).toHaveLength(0);
  });
});

