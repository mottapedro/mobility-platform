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
 *
 * Short-notice scheduled rides (scheduled less than 24 h ahead) have their
 * cutoff clamped to now + 15 min so the offer never expires before the driver
 * has a reasonable window to open the app and accept (see computePolicy).
 */

export const OPERATIONAL_CUTOFF_HOURS = 24;
export const SCHEDULED_OFFER_TIMEOUT_MS = 30 * 60 * 1000;   // 30 minutes per driver
export const IMMEDIATE_OFFER_TIMEOUT_MS = 2 * 60 * 1000;    // 2 minutes per driver
export const REFERRAL_WINDOW_IMMEDIATE_MS = 5 * 60 * 1000;  // 5 minutes (existing behaviour)
export const NETWORK_OFFER_TIMEOUT_MS = 15 * 60 * 1000;     // 15 minutes — network-owned rides (D2P / P2P with rootDriverId)
export const SHORT_NOTICE_OFFER_WINDOW_MS = 15 * 60 * 1000; // 15 minutes — short-notice scheduled rides (<24 h ahead) keep a 15-min offer window

export interface RidePolicy {
  rideStartsAt: Date | null;
  operationalCutoffAt: Date | null;
  offerResponseTimeoutMs: number;
  referralWindowMs: number;
  isScheduled: boolean;
  isNetworkOwned: boolean;
}

export class AcceptancePolicyEngine {
  /**
   * Compute the full acceptance policy for a ride.
   * @param scheduledAt   - The ride's scheduled start time, or null for immediate rides.
   * @param isNetworkOwned - True when the ride belongs to a driver's network
   *                         (passenger has rootDriverId — covers D2P and P2P).
   *                         Raises the offer response timeout to 15 min for
   *                         immediate rides; scheduled rides keep 30 min (already larger).
   */
  static computePolicy(scheduledAt: Date | null | undefined, isNetworkOwned = false): RidePolicy {
    if (!scheduledAt) {
      const offerResponseTimeoutMs = Math.max(
        IMMEDIATE_OFFER_TIMEOUT_MS,
        isNetworkOwned ? NETWORK_OFFER_TIMEOUT_MS : 0,
      );
      return {
        rideStartsAt: null,
        operationalCutoffAt: null,
        offerResponseTimeoutMs,
        referralWindowMs: REFERRAL_WINDOW_IMMEDIATE_MS,
        isScheduled: false,
        isNetworkOwned,
      };
    }

    const rawCutoff = new Date(
      scheduledAt.getTime() - OPERATIONAL_CUTOFF_HOURS * 60 * 60 * 1000
    );
    // Clamp: never set cutoff in the past — short-notice rides (scheduled less
    // than 24 h ahead) keep a 15-min offer window so the driver has time to
    // open the app and accept. 5 min was too tight: the offer expired before
    // a driver with the app closed could react.
    const cutoff = rawCutoff.getTime() > Date.now() + SHORT_NOTICE_OFFER_WINDOW_MS
      ? rawCutoff
      : new Date(Date.now() + SHORT_NOTICE_OFFER_WINDOW_MS);

    // Scheduled referral window: min(30 min, time until cutoff from now)
    const msUntilCutoff = cutoff.getTime() - Date.now();
    const referralWindowMs = Math.max(
      0,
      Math.min(SCHEDULED_OFFER_TIMEOUT_MS, msUntilCutoff)
    );

    const offerResponseTimeoutMs = Math.max(
      SCHEDULED_OFFER_TIMEOUT_MS,
      isNetworkOwned ? NETWORK_OFFER_TIMEOUT_MS : 0,
    );

    return {
      rideStartsAt: scheduledAt,
      operationalCutoffAt: cutoff,
      offerResponseTimeoutMs,
      referralWindowMs,
      isScheduled: true,
      isNetworkOwned,
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
   * For scheduled rides: min(now + 30 min, operationalCutoffAt). The cutoff is
   * clamped to now + 15 min for short-notice rides, so such offers expire 15 min
   * after dispatch (previously 5 min).
   * For immediate rides: now + 2 min (15 min when network-owned).
   */
  static computeOfferExpiry(now: Date, policy: RidePolicy): Date {
    const base = new Date(now.getTime() + policy.offerResponseTimeoutMs);
    if (policy.operationalCutoffAt && base > policy.operationalCutoffAt) {
      return policy.operationalCutoffAt;
    }
    return base;
  }
}
