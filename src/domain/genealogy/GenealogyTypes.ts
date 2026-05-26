import { ActorType, ExperienceLevel, ReferralFlowType } from "../../shared/enums";

export interface GenealogyNode {
  actorId: string;
  actorType: ActorType;
  name: string;
  /** The relationship edge type that brought this actor into the tree. Root node uses DRIVER_TO_DRIVER. */
  flowType: ReferralFlowType;
  /** BFS depth from root. Root node = 0. */
  level: number;
  rootDriverId: string;
  /** Inviter actor ID. Null for the root driver. */
  parentId: string | null;
  publicSlug: string | null;
  referralCode: string | null;
  /** DRIVER only */
  experienceLevel?: ExperienceLevel;
  /** DRIVER only */
  isActive?: boolean;
  networkLevel: number;
  createdAt: Date;
}

export interface GenealogyEdge {
  sourceActorId: string;
  targetActorId: string;
  flowType: ReferralFlowType;
}

export interface GenealogyLevel {
  depth: number;
  nodeIds: string[];
}

export interface GenealogyMetrics {
  totalDrivers: number;
  totalPassengers: number;
  totalRelationships: number;
  totalD2D: number;
  totalD2P: number;
  totalP2P: number;
  maxDepth: number;
}

export interface GenealogyRootDriver {
  id: string;
  name: string;
  experienceLevel: ExperienceLevel | null;
  networkLevel: number;
  publicSlug: string | null;
  referralCode: string | null;
}

export interface GenealogyStats {
  totalNodes: number;
  totalEdges: number;
  maxDepth: number;
  appliedDepthLimit: number;
}

export interface GenealogyProjection {
  rootDriver: GenealogyRootDriver;
  stats: GenealogyStats;
  nodes: GenealogyNode[];
  edges: GenealogyEdge[];
  levels: GenealogyLevel[];
  metrics: GenealogyMetrics;
}
