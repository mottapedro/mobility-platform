/**
 * Ride lifecycle states (pure lifecycle, no dispatch concerns).
 *
 * Dispatch progression (OWNER_DISPATCH → NETWORK_DISPATCH → OWNER_RECOVERY)
 * lives in DispatchCycleStage and RideRequest.dispatchStage — completely
 * separate from lifecycle status. A ride stays REQUESTED throughout the entire
 * dispatch cycle; only when a driver accepts does it transition to ACCEPTED.
 */

import type { PaymentStatus, RideStatus } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Ride lifecycle (pure — no dispatch stages mixed in)
// ─────────────────────────────────────────────────────────────────────────────

export const RideLifecycle = {
  PENDING:    "PENDING",
  ACCEPTED:   "ACCEPTED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED:  "COMPLETED",
  CANCELLED:  "CANCELLED",
} as const satisfies Record<string, RideStatus>;

export type RideLifecycle = (typeof RideLifecycle)[keyof typeof RideLifecycle];

/**
 * Lifecycle transition matrix. Dispatch stages (OWNER_DISPATCH, etc.) are
 * orthogonal — they live on RideRequest.dispatchStage and change while the
 * ride remains REQUESTED.
 */
export const RIDE_LIFECYCLE_TRANSITIONS: Readonly<
  Record<RideLifecycle, readonly RideLifecycle[]>
> = Object.freeze({
  PENDING:    ["ACCEPTED", "CANCELLED"],
  ACCEPTED:   ["IN_PROGRESS", "CANCELLED"],
  "IN_PROGRESS": ["COMPLETED", "CANCELLED"],
  COMPLETED:  [],
  CANCELLED:  [],
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
  PENDING:   "PENDING",
  CONFIRMED: "CONFIRMED",
  FAILED:    "FAILED",
  CANCELLED: "CANCELLED",
} as const satisfies Record<string, PaymentStatus>;

export type PaymentLifecycle =
  (typeof PaymentLifecycle)[keyof typeof PaymentLifecycle];

export const PAYMENT_LIFECYCLE_TRANSITIONS: Readonly<
  Record<PaymentLifecycle, readonly PaymentLifecycle[]>
> = Object.freeze({
  PENDING:   ["CONFIRMED", "FAILED", "CANCELLED"],
  CONFIRMED: [],
  FAILED:    ["PENDING"],
  CANCELLED: [],
});

export function isValidPaymentTransition(
  from: PaymentLifecycle,
  to: PaymentLifecycle,
): boolean {
  return PAYMENT_LIFECYCLE_TRANSITIONS[from].includes(to);
}
