export type MatchingLogStage = "REFERRAL_DIRECT" | "REFERRAL_NETWORK" | "REGION" | "GLOBAL";

export type MatchingLogEvent = {
  rideId: string;
  event:
    | "matching_started"
    | "candidate_stage_built"
    | "offers_prepared"
    | "fallback_triggered"
    | "matching_finished"
    // Acceptance policy events
    | "OFFER_CREATED"
    | "OFFER_EXPIRED"
    | "OFFER_REJECTED"
    | "OFFER_REDISTRIBUTED"
    | "OPERATIONAL_CUTOFF_REACHED"
    | "ACCEPTANCE_WINDOW_CALCULATED";
  stage?: MatchingLogStage;
  candidateDriverIds?: string[];
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
