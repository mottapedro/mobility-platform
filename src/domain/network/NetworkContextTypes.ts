/**
 * NetworkContextTypes
 *
 * Type contract for GET /network/context response.
 * Mirrors the frontend's network-v2.ts verbatim so the response is
 * consumed without transformation by useNetworkContext.
 */

export type FlowType =
  | "DRIVER_TO_DRIVER"
  | "DRIVER_TO_PASSENGER"
  | "PASSENGER_TO_PASSENGER";

export interface NetworkActor {
  id: string;
  actorType: "driver" | "passenger";
  name: string;
  slug?: string | null;
  region?: string | null;
  avatarUrl?: string | null;
  joinedAt?: string | null;
}

export interface NetworkDriverActor extends NetworkActor {
  actorType: "driver";
  vehicle?: {
    brand?: string;
    model?: string;
    plate?: string;
    category?: string;
  } | null;
  rating?: number | null;
  offersAssistedTransport?: boolean;
  regions?: string[] | null;
  networkLevel?: number | null;
}

/** Per-node operational metrics attached to driver genealogy nodes. */
export interface NodeMetrics {
  directPassengerCount: number;
  directDriverCount: number;
  completedRides: number;
}

/** Recursive descendant node — mirrors frontend GenealogyNode. */
export interface FrontendGenealogyNode {
  actor: NetworkActor;
  /** Relative depth from the requesting actor (viewer = 0, direct child = 1). Use for UI badges/labels. */
  depth: number;
  /** Absolute BFS depth from the global root driver (for governance / analytics). */
  absoluteDepth: number;
  children: FrontendGenealogyNode[];
  nodeMetrics?: NodeMetrics;
}

export interface Genealogy {
  /** The requesting actor as a network node. */
  me: NetworkActor;
  /** Chain from immediate inviter up to root. Empty for root drivers. */
  ancestors: NetworkActor[];
  /** Recursive social tree below this actor. Backend guarantees no cycles. */
  descendants: FrontendGenealogyNode[];
  /** Siblings — actors referred by the same parent inviter. */
  lateral: NetworkActor[];
  /** Operational owner — driver who owns this passenger. Null for drivers. */
  operationalOwner: NetworkDriverActor | null;
}

export interface NetworkMetrics {
  totalActors: number;
  activeCount: number;
  depth: number;
  ridesFromNetwork?: number;
  estimatedRevenue?: number;
  growth?: {
    last7Days?: number;
    last30Days?: number;
  };
}

export interface NetworkCapabilityContext {
  canInvitePassengers: boolean;
  canInviteDrivers: boolean;
  canReceiveRewards: boolean;
  canExpandNetwork: boolean;
  skillCodes: string[];
}

/**
 * Top-level response shape for GET /network/context.
 * Frontend MUST NOT infer flowType, ownership, genealogy or referral
 * semantics — everything here is backend-resolved.
 */
export interface NetworkContext {
  flowType: FlowType;
  targetActorExpected: "driver" | "passenger";
  rootDriver: NetworkDriverActor | null;
  genealogy: Genealogy;
  networkMetrics: NetworkMetrics;
  inviteUrls?: {
    /** Canonical DRIVER_TO_DRIVER invite URL. Null when flow not available. */
    d2d?: string | null;
    /** Canonical DRIVER_TO_PASSENGER invite URL. Null when flow not available. */
    d2p?: string | null;
    /** Canonical PASSENGER_TO_PASSENGER invite URL. Null when flow not available. */
    p2p?: string | null;
    /** Legacy alias for d2p. Null for passenger contexts (no cross-flow reuse). */
    driverToPassenger?: string | null;
    /** Legacy alias for d2d. Null for passenger contexts. */
    driverToDriver?: string | null;
    /** Legacy alias for p2p. Null for driver contexts. */
    passengerToPassenger?: string | null;
  } | null;
  capabilities?: NetworkCapabilityContext | null;
}
