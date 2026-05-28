/**
 * ReferralFallbackScheduler
 *
 * Tracks `setTimeout`-based referral fallback jobs scheduled by
 * `MatchRideUseCase` when a ride is offered exclusively to the referring
 * driver. Each timer waits for the configured referral window; if the ride
 * is still WAITING_REFERRAL when it fires, the use-case escalates to
 * network matching.
 *
 * Why this exists:
 *   The referral fallback used to live as a module-local `Set<NodeJS.Timeout>`
 *   with an exported `clearPendingReferralFallbacks` helper consumed only by
 *   test setup. That made it a second, parallel universe of asynchronous
 *   governance — invisible to `lifecycle.shutdownAsync()` and prone to
 *   firing after entity cleanup (creating offers for deleted RideRequests).
 *
 *   By implementing the same `Drainable` contract as `MatchingJobScheduler`,
 *   the referral fallback joins the single operational runtime registry and
 *   participates in graceful shutdown like everyone else.
 *
 * Semantics differ from `MatchingJobScheduler` in one important way:
 *   `schedule` here arms a *delayed* job (setTimeout), so `drain` first
 *   cancels every timer that has not yet fired, then awaits the callbacks
 *   that *did* fire and are still resolving. Pending = cancellable, in-flight
 *   = awaitable. This matches the historical behaviour of
 *   `clearPendingReferralFallbacks()` while adding deterministic await of
 *   work already in progress.
 */

type FallbackFn = () => Promise<void>;

export interface ReferralFallbackDrainOptions {
  timeoutMs?: number;
}

export class ReferralFallbackScheduler {
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inflight = new Set<Promise<void>>();

  /**
   * Arm a fallback to run after `delayMs`. The handle is tracked for
   * cancellation; `.unref?.()` is applied so a pending timer never blocks
   * process exit on its own.
   */
  schedule(delayMs: number, fn: FallbackFn): void {
    const handle: NodeJS.Timeout = setTimeout(() => {
      this.timers.delete(handle);
      const promise = (async () => {
        try {
          await fn();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[ReferralFallbackScheduler] job failed:", err);
        }
      })().finally(() => {
        this.inflight.delete(promise);
      });
      this.inflight.add(promise);
    }, delayMs);

    handle.unref?.();
    this.timers.add(handle);
  }

  /**
   * Cancel every armed timer that has not yet fired. Already-running
   * callbacks are not interrupted (they finish naturally and their
   * completion is observable via `drain`).
   */
  cancelAll(): void {
    for (const handle of this.timers) clearTimeout(handle);
    this.timers.clear();
  }

  /**
   * Cancel all pending timers and await any callbacks already in flight.
   * Jest-friendly timeout via a regular Error on stall.
   */
  async drain(options: ReferralFallbackDrainOptions = {}): Promise<void> {
    this.cancelAll();

    if (this.inflight.size === 0) return;

    const timeoutMs = options.timeoutMs ?? 5000;
    const snapshot = Array.from(this.inflight);
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            `ReferralFallbackScheduler.drain() timed out after ${timeoutMs}ms with ${this.inflight.size} callbacks in flight`,
          ),
        );
      }, timeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      await Promise.race([Promise.all(snapshot), timeout]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /** Test-only helpers. */
  get pendingTimerCount(): number {
    return this.timers.size;
  }
  get inflightCount(): number {
    return this.inflight.size;
  }
}

export const referralFallbackScheduler = new ReferralFallbackScheduler();
