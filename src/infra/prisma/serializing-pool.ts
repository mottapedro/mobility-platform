import type { Pool, PoolClient } from "pg";

/**
 * Wraps a pg.PoolClient so concurrent .query() calls are executed one at a
 * time, in submission order.
 *
 * Why: Prisma's query-interpreter internally maps relation sub-queries in
 * parallel (Array.map) when running inside a transaction. A transactional
 * PoolClient is a single pg.Client, and pg@8.x emits a DeprecationWarning
 * whenever .query() is called while the client already has a pending query
 * (_queryQueue.length > 0). The serializer keeps _queryQueue.length === 0 at
 * the moment each call reaches the underlying client.
 */
export function wrapClientWithSerializer(client: PoolClient): PoolClient {
  // Chain all queries sequentially. Each new call waits for the previous one.
  let queryChain: Promise<unknown> = Promise.resolve();

  const originalQuery = client.query.bind(client) as (
    ...args: Parameters<PoolClient["query"]>
  ) => ReturnType<PoolClient["query"]>;

  // @ts-ignore — override with a type-compatible wrapper
  client.query = (
    ...args: Parameters<PoolClient["query"]>
  ): ReturnType<PoolClient["query"]> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (queryChain as Promise<unknown>).then(
      () => originalQuery(...args)
    ) as unknown as ReturnType<PoolClient["query"]>;

    // Advance the chain; absorb rejections so a failed query doesn't block
    // subsequent ones.
    queryChain = (result as unknown as Promise<unknown>).then(
      () => undefined,
      () => undefined
    );

    return result;
  };

  return client;
}

type ConnectCallback = (
  err: Error | undefined,
  client: PoolClient,
  release: () => void
) => void;

/**
 * Monkey-patches pool.connect() so every PoolClient it returns is wrapped
 * with the query serializer. Call this once after creating the Pool, before
 * handing the Pool to the Prisma adapter.
 *
 * Supports both the Promise form (used by PrismaPg adapter) and the callback
 * form (used internally by pool.query()). Without callback support, pool.query()
 * would silently ignore the callback, causing connections to never be released
 * and pool.end() to hang indefinitely.
 */
export function applyConnectionSerializer(pool: Pool): void {
  const originalConnect = pool.connect.bind(pool);

  // @ts-ignore — override connect() preserving both signatures
  pool.connect = (cb?: ConnectCallback): Promise<PoolClient> | void => {
    if (typeof cb === "function") {
      // Callback form — used internally by pool.query()
      (originalConnect as (cb: ConnectCallback) => void)(
        (err, client, release) => {
          if (err) return cb(err, undefined as unknown as PoolClient, undefined as unknown as () => void);
          cb(undefined as unknown as Error, wrapClientWithSerializer(client), release);
        }
      );
      return undefined;
    }
    // Promise form — used by PrismaPg adapter's startTransaction()
    return (originalConnect as () => Promise<PoolClient>)().then(
      (client) => wrapClientWithSerializer(client)
    );
  };
}
