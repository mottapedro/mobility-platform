export type MatchingLogStage = "REFERRAL_DIRECT" | "REFERRAL_NETWORK" | "REGION" | "GLOBAL";

export type MatchingLogEvent = {
  rideId: string;
  event:
    | "matching_started"
    | "candidate_stage_built"
    | "offers_prepared"
    | "fallback_triggered"
    | "matching_finished"
    // Governed sequential dispatch
    | "candidate_dispatched"
    | "queue_advanced"
    | "single_active_offer_enforced"
    // Acceptance policy events
    | "OFFER_CREATED"
    | "OFFER_QUOTED"
    | "QUOTE_ISSUED"
    | "OFFER_EXPIRED"
    | "OFFER_REJECTED"
    | "OFFER_REDISTRIBUTED"
    | "OPERATIONAL_CUTOFF_REACHED"
    | "OPERATIONAL_ZONE_NOT_CONFIGURED"
    | "ACCEPTANCE_WINDOW_CALCULATED"
    | "RIDE_RESCHEDULED"
    | "RIDE_STARTED"
    | "RIDE_COMPLETED";
  stage?: MatchingLogStage;
  candidateDriverIds?: string[];
  /** New: total candidates in queue for current stage (replaces full id list in broadcast contexts). */
  candidateCount?: number;
  /** New: first N driver ids for debugging, without exposing the full queue. */
  previewCandidateIds?: string[];
  excludedDriverIds?: string[];
  resolvedRegion?: string | null;
  metadata?: Record<string, unknown>;
};

export function logMatchingEvent(event: MatchingLogEvent) {
  console.log(
    JSON.stringify({
      scope: "matching",
      at: new Date().toISOString(),
      ...event,
    })
  );
}
