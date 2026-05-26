/**
 * AppLifecycleManager
 *
 * Manages named setInterval handles and provides a single shutdown hook.
 * Ensures long-lived jobs (offer expiry, projection sync) are cleanly stopped
 * during Jest afterAll teardown and on SIGTERM / SIGINT in production.
 */

const intervals = new Map<string, NodeJS.Timeout>();

export const lifecycle = {
  /** Register (or replace) a named recurring interval. */
  registerInterval(id: string, fn: () => void, ms: number): void {
    const existing = intervals.get(id);
    if (existing !== undefined) clearInterval(existing);
    intervals.set(id, setInterval(fn, ms));
  },

  /** Clear all registered intervals. Call in afterAll and on process shutdown. */
  shutdown(): void {
    for (const handle of intervals.values()) {
      clearInterval(handle);
    }
    intervals.clear();
  },
};
