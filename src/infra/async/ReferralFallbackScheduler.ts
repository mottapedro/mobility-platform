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

import { logRuntimeEvent } from "../../shared/logging/runtimeLog";

const SCHEDULER_NAME = "referralFallbackScheduler";

export interface ReferralFallbackDrainOptions {
  timeoutMs?: number;
}

export class ReferralFallbackScheduler {
  private readonly timers = new Map<string, Set<NodeJS.Timeout>>();
  private readonly inflight = new Map<string, Set<Promise<void>>>();
  private readonly quiescedRides = new Set<string>();

  /**
   * Arm a fallback to run after `delayMs`. The handle is tracked for
   * cancellation; `.unref?.()` is applied so a pending timer never blocks
   * process exit on its own.
   */
  schedule(rideId: string, delayMs: number, fn: FallbackFn): void {
    if (this.quiescedRides.has(rideId)) throw new Error(`ReferralFallbackScheduler ride is quiesced: ${rideId}`);
    const timers = this.timers.get(rideId) ?? new Set<NodeJS.Timeout>();
    this.timers.set(rideId, timers);
    const handle: NodeJS.Timeout = setTimeout(() => {
      timers.delete(handle);
      if (timers.size === 0) this.timers.delete(rideId);
      const inflight = this.inflight.get(rideId) ?? new Set<Promise<void>>();
      this.inflight.set(rideId, inflight);
      const promise = (async () => {
        try {
          await fn();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[ReferralFallbackScheduler] job failed:", err);
        }
      })().finally(() => {
        inflight.delete(promise);
        if (inflight.size === 0) this.inflight.delete(rideId);
      });
      inflight.add(promise);
    }, delayMs);

    handle.unref?.();
    timers.add(handle);
    logRuntimeEvent({
      event: "job_scheduled",
      scheduler: SCHEDULER_NAME,
      pendingCount: timers.size,
      delayMs,
    });
  }

  cancelForRide(rideId: string): void {
    const timers = this.timers.get(rideId);
    if (!timers) return;
    for (const handle of timers) clearTimeout(handle);
    this.timers.delete(rideId);
  }

  async drainForRide(rideId: string, options: ReferralFallbackDrainOptions = {}): Promise<void> {
    this.cancelForRide(rideId);
    const inflight = this.inflight.get(rideId);
    if (!inflight || inflight.size === 0) return;
    const timeoutMs = options.timeoutMs ?? 5000;
    await Promise.race([
      Promise.all(Array.from(inflight)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`ReferralFallbackScheduler.drainForRide(${rideId}) timed out`)), timeoutMs)),
    ]);
  }

  async quiesceForRide(rideId: string, options: ReferralFallbackDrainOptions = {}): Promise<void> {
    this.quiescedRides.add(rideId);
    await this.drainForRide(rideId, options);
  }

  pendingTimerCountForRide(rideId: string): number { return this.timers.get(rideId)?.size ?? 0; }
  inflightCountForRide(rideId: string): number { return this.inflight.get(rideId)?.size ?? 0; }

  /**
   * Cancel every armed timer that has not yet fired. Already-running
   * callbacks are not interrupted (they finish naturally and their
   * completion is observable via `drain`).
   */
  cancelAll(): void {
    const timerSets = Array.from(this.timers.values());
    const cancelled = timerSets.reduce((count, timers) => count + timers.size, 0);
    for (const timers of timerSets) for (const handle of timers) clearTimeout(handle);
    this.timers.clear();
    if (cancelled > 0) {
      logRuntimeEvent({
        event: "timer_cancelled",
        scheduler: SCHEDULER_NAME,
        count: cancelled,
      });
    }
  }

  /**
   * Cancel all pending timers and await any callbacks already in flight.
   * Jest-friendly timeout via a regular Error on stall.
   */
  async drain(options: ReferralFallbackDrainOptions = {}): Promise<void> {
    this.cancelAll();

    const allInflight = Array.from(this.inflight.values()).flatMap((promises) => Array.from(promises));
    if (allInflight.length === 0) return;

    const timeoutMs = options.timeoutMs ?? 5000;
    const startedAt = Date.now();
    const jobsAwaited = allInflight.length;
    logRuntimeEvent({
      event: "drain_started",
      scheduler: SCHEDULER_NAME,
      pendingCount: jobsAwaited,
      timeoutMs,
    });

    const snapshot = allInflight;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;

    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(
          new Error(
            `ReferralFallbackScheduler.drain() timed out after ${timeoutMs}ms with ${allInflight.length} callbacks in flight`,
          ),
        );
      }, timeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      await Promise.race([Promise.all(snapshot), timeout]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      logRuntimeEvent({
        event: "drain_completed",
        scheduler: SCHEDULER_NAME,
        durationMs: Date.now() - startedAt,
        jobsAwaited,
        timedOut,
      });
    }
  }

  /** Test-only helpers. */
  get pendingTimerCount(): number {
    return Array.from(this.timers.values()).reduce((count, timers) => count + timers.size, 0);
  }
  get inflightCount(): number {
    return Array.from(this.inflight.values()).reduce((count, promises) => count + promises.size, 0);
  }
}

export const referralFallbackScheduler = new ReferralFallbackScheduler();
