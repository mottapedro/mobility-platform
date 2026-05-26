/**
 * AcceptancePolicyEngine
 *
 * Separates three distinct temporal concepts:
 *   1. operationalCutoffAt  — deadline after which redistribution is impossible
 *                             (scheduledAt - 24 h for scheduled rides; null for immediate)
 *   2. offerResponseTimeout — how long each individual driver has to respond
 *                             (30 min for scheduled rides; 2 min for immediate)
 *   3. referralWindow       — exclusivity window for the referred driver
 *                             (min(30 min, time until cutoff) for scheduled; 5 min for immediate)
 */

export const OPERATIONAL_CUTOFF_HOURS = 24;
export const SCHEDULED_OFFER_TIMEOUT_MS = 30 * 60 * 1000;   // 30 minutes per driver
export const IMMEDIATE_OFFER_TIMEOUT_MS = 2 * 60 * 1000;    // 2 minutes per driver
export const REFERRAL_WINDOW_IMMEDIATE_MS = 5 * 60 * 1000;  // 5 minutes (existing behaviour)

export interface RidePolicy {
  rideStartsAt: Date | null;
  operationalCutoffAt: Date | null;
  offerResponseTimeoutMs: number;
  referralWindowMs: number;
  isScheduled: boolean;
}

export class AcceptancePolicyEngine {
  /**
   * Compute the full acceptance policy for a ride.
   * @param scheduledAt - The ride's scheduled start time, or null for immediate rides.
   */
  static computePolicy(scheduledAt: Date | null | undefined): RidePolicy {
    if (!scheduledAt) {
      return {
        rideStartsAt: null,
        operationalCutoffAt: null,
        offerResponseTimeoutMs: IMMEDIATE_OFFER_TIMEOUT_MS,
        referralWindowMs: REFERRAL_WINDOW_IMMEDIATE_MS,
        isScheduled: false,
      };
    }

    const cutoff = new Date(
      scheduledAt.getTime() - OPERATIONAL_CUTOFF_HOURS * 60 * 60 * 1000
    );

    // Scheduled referral window: min(30 min, time until cutoff from now)
    const msUntilCutoff = cutoff.getTime() - Date.now();
    const referralWindowMs = Math.max(
      0,
      Math.min(SCHEDULED_OFFER_TIMEOUT_MS, msUntilCutoff)
    );

    return {
      rideStartsAt: scheduledAt,
      operationalCutoffAt: cutoff,
      offerResponseTimeoutMs: SCHEDULED_OFFER_TIMEOUT_MS,
      referralWindowMs,
      isScheduled: true,
    };
  }

  /**
   * Returns true when redistribution should be halted because the operational
   * cutoff has been reached or passed.
   */
  static isBeyondCutoff(now: Date, policy: RidePolicy): boolean {
    if (!policy.operationalCutoffAt) return false;
    return now.getTime() >= policy.operationalCutoffAt.getTime();
  }

  /**
   * Compute the expiry timestamp for a single offer.
   *
   * For scheduled rides: min(now + 30 min, operationalCutoffAt)
   * For immediate rides: now + 2 min
   */
  static computeOfferExpiry(now: Date, policy: RidePolicy): Date {
    const base = new Date(now.getTime() + policy.offerResponseTimeoutMs);
    if (policy.operationalCutoffAt && base > policy.operationalCutoffAt) {
      return policy.operationalCutoffAt;
    }
    return base;
  }
}
