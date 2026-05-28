/**
 * AppLifecycleManager
 *
 * Single source of truth for the application runtime: named recurring
 * intervals AND fire-and-forget schedulers (drainables) register here so a
 * single shutdown hook can stop everything cleanly during Jest `afterAll`
 * teardown and on SIGTERM / SIGINT in production.
 *
 * Two shutdown surfaces:
 *   - `shutdown()`        synchronous; clears intervals only (legacy callers).
 *   - `shutdownAsync()`   awaits every registered drainable (e.g. matching
 *                          jobs in flight) before clearing intervals. Use
 *                          this in production signal handlers and prefer it
 *                          in tests so background work cannot race teardown.
 */

export interface Drainable {
  drain(options?: { timeoutMs?: number }): Promise<void>;
}

export interface ShutdownAsyncOptions {
  /**
   * Per-drainable timeout passed to `drain`. Defaults to 30s (production-safe
   * upper bound for graceful Kubernetes terminationGracePeriodSeconds).
   */
  drainTimeoutMs?: number;
}

const intervals = new Map<string, NodeJS.Timeout>();
const drainables = new Map<string, Drainable>();

export const lifecycle = {
  /** Register (or replace) a named recurring interval. */
  registerInterval(id: string, fn: () => void, ms: number): void {
    const existing = intervals.get(id);
    if (existing !== undefined) clearInterval(existing);
    intervals.set(id, setInterval(fn, ms));
  },

  /**
   * Register (or replace) a named drainable. Drainables are awaited in
   * insertion order by `shutdownAsync` before intervals are cleared.
   */
  registerDrainable(id: string, target: Drainable): void {
    drainables.set(id, target);
  },

  /** Clear all registered intervals (synchronous). */
  shutdown(): void {
    for (const handle of intervals.values()) {
      clearInterval(handle);
    }
    intervals.clear();
  },

  /**
   * Drain every registered drainable, then clear intervals. Errors from
   * individual drainables are logged and aggregated; teardown proceeds for
   * the remaining drainables so a stuck job cannot block process exit.
   */
  async shutdownAsync(options: ShutdownAsyncOptions = {}): Promise<void> {
    const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
    const errors: unknown[] = [];

    for (const [id, target] of drainables) {
      try {
        await target.drain({ timeoutMs: drainTimeoutMs });
      } catch (err) {
        console.error(`[lifecycle] drain failed for "${id}":`, err);
        errors.push(err);
      }
    }

    this.shutdown();

    if (errors.length > 0) {
      const aggregate = new Error(
        `Lifecycle shutdown encountered ${errors.length} drain error(s)`,
      ) as Error & { errors: unknown[] };
      aggregate.errors = errors;
      throw aggregate;
    }
  },

  /** Test-only helper: drop all registrations without running them. */
  __resetForTests(): void {
    for (const handle of intervals.values()) clearInterval(handle);
    intervals.clear();
    drainables.clear();
  },
};
