/**
 * MatchingJobScheduler
 *
 * Centralizes fire-and-forget background jobs spawned by HTTP controllers
 * (notably matching kicks after ride creation and offer rejection).
 *
 * Why this exists:
 *   Controllers used to call `setImmediate(async () => useCase.execute(...))`
 *   directly. In production this is fine, but in integration tests the
 *   `beforeEach` cleanup would race with in-flight matching jobs and trigger
 *   foreign-key violations (e.g. RideOffer_rideRequestId_fkey) when the
 *   matching write landed *after* its parent RideRequest had been deleted.
 *
 *   By routing every fire-and-forget through this scheduler we gain:
 *     - a single observable inventory of pending background work
 *     - the ability to await quiescence (`drain`) before mutating shared state
 *     - a future seam for cancellation, retry policy and metrics (Fase 2+)
 *
 * Production semantics are intentionally unchanged: `schedule` still runs
 * the callback asynchronously via `setImmediate`; only test code is expected
 * to call `drain`.
 */

type JobFn = () => Promise<void>;

import { logRuntimeEvent } from "../../shared/logging/runtimeLog";

const SCHEDULER_NAME = "matchingJobScheduler";

export interface DrainOptions {
  /**
   * Hard upper bound, in milliseconds, on how long `drain` will wait for
   * pending jobs to settle. Defaults to 5000ms which is comfortably above
   * any realistic matching execution while still failing fast in tests.
   */
  timeoutMs?: number;
}

export class MatchingJobScheduler {
  private readonly pending = new Set<Promise<void>>();

  /**
   * Schedule a fire-and-forget job. Returns synchronously; the job runs on
   * the next tick via `setImmediate`. Errors are swallowed (matching errors
   * are already logged at the use-case layer) but the promise is tracked so
   * `drain` can await completion regardless of outcome.
   */
  schedule(fn: JobFn): void {
    const job = new Promise<void>((resolve) => {
      setImmediate(() => {
        fn()
          .catch((error) => {
            // Mirror the previous setImmediate behaviour: log but don't crash.
            // eslint-disable-next-line no-console
            console.error("[MatchingJobScheduler] job failed:", error);
          })
          .finally(() => {
            this.pending.delete(job);
            resolve();
          });
      });
    });
    this.pending.add(job);
    logRuntimeEvent({
      event: "job_scheduled",
      scheduler: SCHEDULER_NAME,
      pendingCount: this.pending.size,
    });
  }

  /**
   * Await all in-flight jobs. Intended for test teardown / beforeEach.
   * Throws a Jest-friendly error if jobs do not settle within `timeoutMs`.
   */
  async drain(options: DrainOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5000;
    if (this.pending.size === 0) return;

    const startedAt = Date.now();
    const jobsAwaited = this.pending.size;
    logRuntimeEvent({
      event: "drain_started",
      scheduler: SCHEDULER_NAME,
      pendingCount: jobsAwaited,
      timeoutMs,
    });

    const snapshot = Array.from(this.pending);
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;

    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(
          new Error(
            `MatchingJobScheduler.drain() timed out after ${timeoutMs}ms with ${this.pending.size} jobs in flight`,
          ),
        );
      }, timeoutMs);
      // Don't keep the event loop alive solely for this timer.
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

  /**
   * Phase 2 hook: forget tracked jobs without awaiting them. Currently a
   * no-op placeholder so callers (e.g. AppLifecycleManager shutdown) can be
   * wired now and gain real cancellation later without API churn.
   */
  cancelAll(): void {
    // Intentionally empty for Fase 1. See operational-lifecycle-plan.md.
  }

  /** Test-only helper: how many jobs are currently tracked. */
  get pendingCount(): number {
    return this.pending.size;
  }
}

export const matchingJobScheduler = new MatchingJobScheduler();
