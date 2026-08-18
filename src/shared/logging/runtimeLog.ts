/**
 * Runtime telemetry
 *
 * Structured logs for the operational runtime registry: scheduler/interval
 * registration, drain cycles, timer cancellation. Mirrors the shape of
 * `logMatchingEvent` so downstream log pipelines treat both families
 * uniformly (`scope` distinguishes them).
 *
 * Goal: make Fase 2b validation (graceful shutdown in staging) falsifiable
 * via metrics ("drain_completed durationMs", "jobsAwaited", "timer_cancelled
 * count") instead of eyeballing console output.
 */

export type RuntimeLogEvent =
  | {
      event: "scheduler_registered";
      registry: "drainable" | "interval";
      id: string;
    }
  | {
      event: "job_scheduled";
      scheduler: string;
      pendingCount: number;
      delayMs?: number;
    }
  | {
      event: "drain_started";
      scheduler: string;
      pendingCount: number;
      timeoutMs: number;
    }
  | {
      event: "drain_completed";
      scheduler: string;
      durationMs: number;
      jobsAwaited: number;
      timedOut?: boolean;
    }
  | {
      event: "timer_cancelled";
      scheduler: string;
      count: number;
    }
  | {
      event: "shutdown_started";
      drainableIds: string[];
      drainTimeoutMs: number;
    }
  | {
      event: "shutdown_completed";
      durationMs: number;
      errors: number;
    };

export function logRuntimeEvent(event: RuntimeLogEvent): void {
  console.log(
    JSON.stringify({
      scope: "runtime",
      at: new Date().toISOString(),
      ...event,
    }),
  );
}
