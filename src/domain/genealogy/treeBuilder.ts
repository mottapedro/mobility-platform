/**
 * treeBuilder
 *
 * Converts the flat { nodes, edges } output from BuildGenealogyProjectionService
 * into the recursive FrontendGenealogyNode[] tree the frontend expects.
 *
 * The function returns the DESCENDANTS of `rootActorId` — the root node
 * itself is excluded; only its children and below are included.
 */

import { ActorType } from "../../shared/enums";
import {
  GenealogyEdge,
  GenealogyNode as BackendGenealogyNode,
} from "./GenealogyTypes";
import { FrontendGenealogyNode, NetworkActor } from "../network/NetworkContextTypes";

function toNetworkActor(node: BackendGenealogyNode): NetworkActor {
  return {
    id: node.actorId,
    actorType: node.actorType === ActorType.DRIVER ? "driver" : "passenger",
    name: node.name,
    slug: node.publicSlug ?? null,
    joinedAt: node.createdAt instanceof Date ? node.createdAt.toISOString() : null,
  };
}

/**
 * Build a recursive descendant tree from flat BFS output.
 *
 * @param flatNodes  All nodes returned by buildGenealogyProjection (includes root).
 * @param edges      All edges returned by buildGenealogyProjection.
 * @param rootActorId  The actor whose direct children start the tree.
 * @param _rootActorType  Unused — kept for API clarity / future actor-scoped edges.
 */
export function buildDescendantsTree(
  flatNodes: BackendGenealogyNode[],
  edges: GenealogyEdge[],
  rootActorId: string,
  _rootActorType: ActorType
): FrontendGenealogyNode[] {
  // Index nodes by actorId for O(1) lookups
  const nodeMap = new Map<string, BackendGenealogyNode>();
  for (const node of flatNodes) {
    nodeMap.set(node.actorId, node);
  }

  // Build adjacency list: sourceActorId → targetActorId[]
  const childrenMap = new Map<string, string[]>();
  for (const edge of edges) {
    const list = childrenMap.get(edge.sourceActorId) ?? [];
    list.push(edge.targetActorId);
    childrenMap.set(edge.sourceActorId, list);
  }

  // Absolute BFS level of the viewer — used to normalise all descendant depths.
  // If viewer is not in the BFS result (e.g. they are the global root), default to 0.
  const viewerAbsoluteLevel = nodeMap.get(rootActorId)?.level ?? 0;

  // Recursive tree builder (cycle-safe via nodeMap lookup only — BFS already de-cycled)
  function buildSubtree(actorId: string): FrontendGenealogyNode | null {
    const node = nodeMap.get(actorId);
    if (!node) return null;

    const childIds = childrenMap.get(actorId) ?? [];
    const children = childIds
      .map(buildSubtree)
      .filter((c): c is FrontendGenealogyNode => c !== null);

    return {
      actor: toNetworkActor(node),
      depth: node.level - viewerAbsoluteLevel,   // relative to viewer
      absoluteDepth: node.level,                  // absolute from global root
      children,
    };
  }

  // Return children of rootActorId (excluding root itself)
  const directChildIds = childrenMap.get(rootActorId) ?? [];
  return directChildIds
    .map(buildSubtree)
    .filter((c): c is FrontendGenealogyNode => c !== null);
}
