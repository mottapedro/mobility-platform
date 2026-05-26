/**
 * Unit tests for the pg PoolClient query serializer.
 *
 * The serializer wraps a pg.PoolClient so that concurrent calls to .query()
 * are queued and executed one at a time. This prevents the pg@8.x
 * DeprecationWarning "Calling client.query() when the client is already
 * executing a query" that Prisma's query-interpreter triggers when it
 * internally runs relation sub-queries in parallel inside a transaction.
 */
import {
  wrapClientWithSerializer,
  applyConnectionSerializer,
} from "../src/infra/prisma/serializing-pool";
import type { Pool, PoolClient } from "pg";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface MockPoolClient {
  query: (...args: unknown[]) => Promise<{ rows: unknown[] }>;
  release: jest.Mock;
  // allows reading the maxConcurrent watermark from the test
  _maxConcurrent?: number;
}

function makeMockClient(): MockPoolClient & {
  _activeCount: number;
  _maxConcurrent: number;
  _callLog: string[];
} {
  const client = {
    _activeCount: 0,
    _maxConcurrent: 0,
    _callLog: [] as string[],
    release: jest.fn(),
    query: async (sql: unknown) => {
      client._activeCount++;
      if (client._activeCount > client._maxConcurrent) {
        client._maxConcurrent = client._activeCount;
      }
      client._callLog.push(`start:${sql}`);
      // Yield so other concurrent callers can interleave (without serializer they will)
      await new Promise<void>((r) => setImmediate(r));
      client._callLog.push(`end:${sql}`);
      client._activeCount--;
      return { rows: [] };
    },
  };

  return client;
}

// ── wrapClientWithSerializer ─────────────────────────────────────────────────

describe("wrapClientWithSerializer", () => {
  it("executes queries sequentially even when called concurrently", async () => {
    const mock = makeMockClient();
    const wrapped = wrapClientWithSerializer(mock as unknown as PoolClient);

    await Promise.all([
      wrapped.query("A" as never),
      wrapped.query("B" as never),
      wrapped.query("C" as never),
    ]);

    expect(mock._maxConcurrent).toBe(1);
    expect(mock._callLog).toEqual([
      "start:A",
      "end:A",
      "start:B",
      "end:B",
      "start:C",
      "end:C",
    ]);
  });

  it("resolves each promise with the underlying query result", async () => {
    const mock = makeMockClient();
    // Override to return a meaningful row for one query
    mock.query = async (sql: unknown) => ({ rows: [{ sql }] });

    const wrapped = wrapClientWithSerializer(mock as unknown as PoolClient);
    const result = await wrapped.query("SELECT 1" as never);

    expect(result).toEqual({ rows: [{ sql: "SELECT 1" }] });
  });

  it("continues processing queued queries even if one rejects", async () => {
    const mock = makeMockClient();
    let callCount = 0;
    mock.query = async (sql: unknown) => {
      callCount++;
      if (callCount === 1) throw new Error("simulated pg error");
      return { rows: [{ sql }] };
    };

    const wrapped = wrapClientWithSerializer(mock as unknown as PoolClient);

    const [p1, p2] = await Promise.allSettled([
      wrapped.query("FAIL" as never),
      wrapped.query("OK" as never),
    ]);

    expect(p1.status).toBe("rejected");
    expect(p2.status).toBe("fulfilled");
    expect(callCount).toBe(2);
  });
});

// ── applyConnectionSerializer ─────────────────────────────────────────────────

/** A minimal fake Pool whose connect() supports both Promise and callback forms. */
function makeFakePool(
  client: MockPoolClient
): Pool & { _connectCallCount: number } {
  const fakePool = {
    _connectCallCount: 0,
    connect(
      cb?: (
        err: Error | undefined,
        c: PoolClient,
        release: () => void
      ) => void
    ) {
      fakePool._connectCallCount++;
      const release = jest.fn();
      if (typeof cb === "function") {
        process.nextTick(() =>
          cb(undefined, client as unknown as PoolClient, release)
        );
        return undefined;
      }
      return Promise.resolve(client as unknown as PoolClient);
    },
  } as unknown as Pool & { _connectCallCount: number };
  return fakePool;
}

describe("applyConnectionSerializer", () => {
  it("patches pool.connect() (Promise form) so returned clients are serialized", async () => {
    const mock = makeMockClient();
    const fakePool = makeFakePool(mock);

    applyConnectionSerializer(fakePool);

    const client = await fakePool.connect();

    await Promise.all([
      client.query("X" as never),
      client.query("Y" as never),
    ]);

    expect(mock._maxConcurrent).toBe(1);
  });

  it("patches pool.connect() (callback form) so returned clients are serialized", (done) => {
    const mock = makeMockClient();
    const fakePool = makeFakePool(mock);

    applyConnectionSerializer(fakePool);

    // pool.query() uses the callback form internally
    (fakePool.connect as unknown as (
      cb: (err: Error | undefined, client: PoolClient, release: () => void) => void
    ) => void)((err, client, _release) => {
      expect(err).toBeUndefined();

      Promise.all([
        client.query("P" as never),
        client.query("Q" as never),
      ]).then(() => {
        expect(mock._maxConcurrent).toBe(1);
        done();
      });
    });
  });
});
