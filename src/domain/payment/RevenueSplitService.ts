/**
 * Pure revenue-split calculator for the Aliado payment domain.
 *
 * Rule (PR-2):
 *   - Driver:       80%  (8000 bps)
 *   - Platform:     15%  (1500 bps)
 *   - Root driver:   5%  ( 500 bps)
 *
 * When rootDriverId is null, the 5% rolls into Platform — total cents are
 * always preserved. Integer-cents math; the floor remainder lands on the
 * root-driver bucket so the sum invariant holds.
 */

export const SPLIT_BPS = {
  DRIVER: 8000,
  PLATFORM: 1500,
  ROOT_DRIVER: 500,
} as const;

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

  const driverCents = Math.floor((totalCents * SPLIT_BPS.DRIVER) / 10_000);
  const platformBase = Math.floor((totalCents * SPLIT_BPS.PLATFORM) / 10_000);
  const remainder = totalCents - driverCents - platformBase;

  if (rootDriverId === null) {
    return {
      totalCents,
      driverCents,
      platformCents: platformBase + remainder,
      rootDriverCents: 0,
      rootDriverId: null,
    };
  }

  return {
    totalCents,
    driverCents,
    platformCents: platformBase,
    rootDriverCents: remainder,
    rootDriverId,
  };
}
