export type MatchingLogStage = "REFERRAL_DIRECT" | "REFERRAL_NETWORK" | "REGION" | "GLOBAL";

export type MatchingLogEvent = {
  rideId: string;
  event:
    | "matching_started"
    | "candidate_stage_built"
    | "offers_prepared"
    | "fallback_triggered"
    | "matching_finished";
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
