/**
 * ADR-001 — Economic Domain (MVP)
 *
 * RevenueSplitService: liquidates pre-calculated values from the Pricing Snapshot.
 *
 * Rule (ADR-001 §3 + §4):
 *   - Platform fee : R$2,50 fixed (PLATFORM_FEE_CENTS constant)
 *   - Driver share : totalCents - platformFeeCents
 *   - Root driver  : 0 (reserved for RevenueSplit V2 / Ownership phase)
 *
 * REMOVED: percentage-based 80/15/5 split model.
 * Settlement does NOT recalculate prices — it liquidates what the Pricing Engine persisted.
 */

export const PLATFORM_FEE_CENTS = 250; // R$2,50 — Taxa Operacional Cyborg (MVP)

export interface ComputeRevenueSplitInput {
  totalCents: number;
  rootDriverId: string | null;
}

export interface RevenueSplitResult {
  totalCents: number;
  driverCents: number;
  platformCents: number;
  rootDriverCents: number;
  rootDriverId: string | null;
}

export function computeRevenueSplit(
  input: ComputeRevenueSplitInput
): RevenueSplitResult {
  const { totalCents, rootDriverId } = input;

  if (!Number.isInteger(totalCents)) {
    throw new Error(`totalCents must be an integer, got ${totalCents}`);
  }
  if (totalCents <= 0) {
    throw new Error(`totalCents must be > 0, got ${totalCents}`);
  }
  if (totalCents <= PLATFORM_FEE_CENTS) {
    throw new Error(
      `totalCents (${totalCents}) must exceed platform fee (${PLATFORM_FEE_CENTS})`
    );
  }

  const platformCents = PLATFORM_FEE_CENTS;
  const driverCents = totalCents - platformCents;

  return {
    totalCents,
    driverCents,
    platformCents,
    rootDriverCents: 0, // Reserved for RevenueSplit V2 (ADR-001 §8 step 7)
    rootDriverId,
  };
}
