/**
 * TS-only lifecycle mirrors for Ride and Payment.
 *
 * These do NOT live in Prisma because the Prisma enums (`RideStatus`,
 * `PaymentStatus`) are persistence-level value sets. The lifecycles here are
 * domain-level state machines used by the RideExecutionDomain and the
 * Payment orchestrator to gate transitions.
 *
 * The lifecycle values are a strict subset of the Prisma enums, modeled as
 * `const` objects (so both runtime values and types are available) and a
 * transition matrix used by domain services to validate state changes.
 */

import type { PaymentStatus, RideStatus } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Ride lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export const RideLifecycle = {
  PENDING: "PENDING",
  MATCHING: "MATCHING",
  WAITING_DRIVER: "WAITING_DRIVER",
  ACCEPTED: "ACCEPTED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
  PAID: "PAID",
} as const satisfies Record<string, RideStatus>;

export type RideLifecycle = (typeof RideLifecycle)[keyof typeof RideLifecycle];

/**
 * Authoritative transition matrix for the ride lifecycle. Each key maps to
 * the set of statuses it is allowed to transition INTO.
 */
export const RIDE_LIFECYCLE_TRANSITIONS: Readonly<
  Record<RideLifecycle, readonly RideLifecycle[]>
> = Object.freeze({
  PENDING: ["MATCHING", "CANCELLED", "EXPIRED"],
  MATCHING: ["WAITING_DRIVER", "EXPIRED", "CANCELLED"],
  WAITING_DRIVER: ["ACCEPTED", "EXPIRED", "CANCELLED"],
  ACCEPTED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: ["PAID"],
  PAID: [],
  CANCELLED: [],
  EXPIRED: [],
});

export function isValidRideTransition(
  from: RideLifecycle,
  to: RideLifecycle,
): boolean {
  return RIDE_LIFECYCLE_TRANSITIONS[from].includes(to);
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export const PaymentLifecycle = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const satisfies Record<string, PaymentStatus>;

export type PaymentLifecycle =
  (typeof PaymentLifecycle)[keyof typeof PaymentLifecycle];

export const PAYMENT_LIFECYCLE_TRANSITIONS: Readonly<
  Record<PaymentLifecycle, readonly PaymentLifecycle[]>
> = Object.freeze({
  PENDING: ["CONFIRMED", "FAILED", "CANCELLED"],
  CONFIRMED: [],
  FAILED: ["PENDING"],
  CANCELLED: [],
});

export function isValidPaymentTransition(
  from: PaymentLifecycle,
  to: PaymentLifecycle,
): boolean {
  return PAYMENT_LIFECYCLE_TRANSITIONS[from].includes(to);
}
