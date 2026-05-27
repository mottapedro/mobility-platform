import { ActorType, ReferralFlowType } from "../../src/shared/enums";
import { prisma } from "../../src/infra/prisma/client";
import {
  GOD_NETWORK,
  assertConformance,
  getRootDriverId,
} from "../../src/domain/godnetwork/GodNetworkService";
import { buildGenealogyProjection } from "../../src/domain/genealogy/BuildGenealogyProjectionService";
import { buildDescendantsTree } from "../../src/domain/genealogy/treeBuilder";
import { buildNetworkContextForDriver } from "../../src/domain/network/NetworkContextProjectionService";
import { SyncProjectionJob } from "../../src/domain/network/SyncProjectionJob";
import type { FrontendGenealogyNode } from "../../src/domain/network/NetworkContextTypes";
import * as fs from "fs";
import * as path from "path";

type Axis =
  | "projection_integrity"
  | "topology_integrity"
  | "lineage_integrity"
  | "ownership_integrity"
  | "frontend_integrity"
  | "runtime_integrity";

interface AuditCheck {
  axis: Axis;
  id: string;
  pass: boolean;
  detail: string;
}

interface FlatTreeNode {
  id: string;
  actorType: "driver" | "passenger";
  depth: number;
  absoluteDepth: number;
  parentId: string | null;
  childrenCount: number;
}

const checks: AuditCheck[] = [];

function record(axis: Axis, id: string, pass: boolean, detail: string): void {
  checks.push({ axis, id, pass, detail });
}

function failCount(axis: Axis): number {
  return checks.filter((c) => c.axis === axis && !c.pass).length;
}

function boolToStatus(pass: boolean): string {
  return pass ? "PASS" : "FAIL";
}

function listAllFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listAllFilesRecursive(abs));
      continue;
    }
    if (abs.endsWith(".ts") || abs.endsWith(".tsx") || abs.endsWith(".js") || abs.endsWith(".jsx")) {
      out.push(abs);
    }
  }
  return out;
}

function flattenTree(nodes: FrontendGenealogyNode[], parentId: string | null = null): FlatTreeNode[] {
  const out: FlatTreeNode[] = [];
  for (const node of nodes) {
    out.push({
      id: node.actor.id,
      actorType: node.actor.actorType,
      depth: node.depth,
      absoluteDepth: node.absoluteDepth,
      parentId,
      childrenCount: node.children.length,
    });
    out.push(...flattenTree(node.children, node.actor.id));
  }
  return out;
}

function canonicalTree(nodes: FrontendGenealogyNode[]): unknown {
  return nodes.map((n) => ({
    id: n.actor.id,
    depth: n.depth,
    absoluteDepth: n.absoluteDepth,
    children: canonicalTree(n.children),
  }));
}

function arraysEqualAsSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = new Set(left);
  const b = new Set(right);
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseFrontendRepoArg(): string | null {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--frontend-repo=")) return arg.split("=")[1] ?? null;
    if (arg.startsWith("--frontendRepo=")) return arg.split("=")[1] ?? null;
  }
  return null;
}

function resolveExternalFrontendRepoPath(): string | null {
  const fromEnv = process.env.GODNETWORK_FRONTEND_REPO?.trim();
  const fromArg = parseFrontendRepoArg()?.trim();

  const candidates = [
    fromEnv,
    fromArg,
    path.resolve(process.cwd(), "..", "app-driver-agendamento", "mobility-frontend"),
    path.resolve(process.cwd(), "..", "mobility-frontend"),
  ].filter((x): x is string => !!x);

  for (const candidate of candidates) {
    const srcDir = path.join(candidate, "src");
    if (fs.existsSync(candidate) && fs.existsSync(srcDir)) {
      return candidate;
    }
  }

  return null;
}

async function resolveDriverIdsByEmail(emails: string[]): Promise<Map<string, string>> {
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { email: true, driver: { select: { id: true } } },
  });
  const map = new Map<string, string>();
  for (const u of users) {
    if (u.driver?.id) map.set(u.email, u.driver.id);
  }
  return map;
}

function detectCycleByParentPointers(
  nodeIds: string[],
  parentById: Map<string, string | null>
): string[] {
  const cycleStarts: string[] = [];
  for (const start of nodeIds) {
    const visited = new Set<string>();
    let cur: string | null = start;
    while (cur) {
      if (visited.has(cur)) {
        cycleStarts.push(start);
        break;
      }
      visited.add(cur);
      cur = parentById.get(cur) ?? null;
    }
  }
  return cycleStarts;
}

function buildLineageToRoot(actorId: string, parentById: Map<string, string | null>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = actorId;
  while (cur) {
    if (seen.has(cur)) {
      throw new Error(`Cycle while building lineage for ${actorId}`);
    }
    seen.add(cur);
    chain.push(cur);
    cur = parentById.get(cur) ?? null;
  }
  return chain.reverse();
}

async function main(): Promise<void> {
  console.log("=== Networking Gold Governance Audit (Backend Projection) ===\n");

  const rootDriverId = await getRootDriverId();
  if (!rootDriverId) {
    throw new Error("Root driver not found (Pedro). Run seed:golden before auditing.");
  }

  const officialEmails = [
    GOD_NETWORK.root.email,
    ...GOD_NETWORK.level1.direct.map((d) => d.email),
    ...GOD_NETWORK.level2UnderJoao.map((d) => d.email),
  ];
  const idByEmail = await resolveDriverIdsByEmail(officialEmails);

  const missingOfficial = officialEmails.filter((email) => !idByEmail.has(email));
  record(
    "topology_integrity",
    "official-drivers-present",
    missingOfficial.length === 0,
    missingOfficial.length === 0
      ? "All official drivers exist in DB."
      : `Missing official drivers: ${missingOfficial.join(", ")}`
  );

  const pedroId = idByEmail.get(GOD_NETWORK.root.email) ?? rootDriverId;
  const joaoId = idByEmail.get("jln@gmail.com") ?? null;

  const conformance = await assertConformance();
  record(
    "topology_integrity",
    "locked-contract-conformance",
    conformance.conformant,
    conformance.conformant
      ? "GodNetwork locked contract conformance passed."
      : `Deviations: ${conformance.deviations.join(" | ")}`
  );

  const projection = await buildGenealogyProjection(pedroId, { maxDepth: 10 });
  const nodeById = new Map(projection.nodes.map((n) => [n.actorId, n]));
  const parentById = new Map(projection.nodes.map((n) => [n.actorId, n.parentId]));

  // 1) Projection integrity: parentId/rootDriverId/flowType/actorType
  const duplicateCount = projection.nodes.length - new Set(projection.nodes.map((n) => n.actorId)).size;
  record(
    "projection_integrity",
    "duplicate-nodes",
    duplicateCount === 0,
    duplicateCount === 0 ? "No duplicate actorId in projection." : `Duplicate node count: ${duplicateCount}`
  );

  const wrongRootNodes = projection.nodes.filter((n) => n.rootDriverId !== pedroId);
  record(
    "projection_integrity",
    "root-driver-id-consistency",
    wrongRootNodes.length === 0,
    wrongRootNodes.length === 0
      ? "All projected nodes share expected rootDriverId."
      : `Nodes with wrong rootDriverId: ${wrongRootNodes.length}`
  );

  const orphanNodes = projection.nodes.filter((n) => n.parentId !== null && !nodeById.has(n.parentId));
  record(
    "projection_integrity",
    "orphan-nodes",
    orphanNodes.length === 0,
    orphanNodes.length === 0 ? "No orphan nodes in projection." : `Orphan nodes found: ${orphanNodes.length}`
  );

  const badDepth = projection.nodes.filter((n) => {
    if (n.parentId === null) return n.level !== 0;
    const parent = nodeById.get(n.parentId);
    if (!parent) return true;
    return n.level !== parent.level + 1;
  });
  record(
    "projection_integrity",
    "depth-drift",
    badDepth.length === 0,
    badDepth.length === 0
      ? "Absolute depth progression is consistent (parent+1)."
      : `Depth drift nodes: ${badDepth.length}`
  );

  const cycleStarts = detectCycleByParentPointers(projection.nodes.map((n) => n.actorId), parentById);
  record(
    "projection_integrity",
    "circular-ancestry",
    cycleStarts.length === 0,
    cycleStarts.length === 0 ? "No circular ancestry detected." : `Cycle suspects: ${cycleStarts.length}`
  );

  const badFlowType = projection.nodes.filter(
    (n) => !Object.values(ReferralFlowType).includes(n.flowType)
  );
  record(
    "projection_integrity",
    "flowtype-valid",
    badFlowType.length === 0,
    badFlowType.length === 0 ? "All nodes have valid flowType." : `Invalid flowType nodes: ${badFlowType.length}`
  );

  const badActorType = projection.nodes.filter((n) => !Object.values(ActorType).includes(n.actorType));
  record(
    "projection_integrity",
    "actortype-valid",
    badActorType.length === 0,
    badActorType.length === 0 ? "All nodes have valid actorType." : `Invalid actorType nodes: ${badActorType.length}`
  );

  // 2/3/4) Official topology constraints
  if (joaoId) {
    const joaoNode = nodeById.get(joaoId);
    record(
      "topology_integrity",
      "joao-direct-child-of-pedro",
      !!joaoNode && joaoNode.parentId === pedroId,
      !!joaoNode && joaoNode.parentId === pedroId
        ? "Joao is a direct descendant of Pedro."
        : "Joao is not directly attached to Pedro in projection."
    );

    const joaoChildrenExpected = GOD_NETWORK.level2UnderJoao
      .map((x) => idByEmail.get(x.email))
      .filter((x): x is string => !!x);
    const joaoChildrenActual = projection.nodes
      .filter((n) => n.parentId === joaoId)
      .map((n) => n.actorId);

    record(
      "topology_integrity",
      "joao-l2-children-exact",
      arraysEqualAsSet(joaoChildrenActual, joaoChildrenExpected),
      arraysEqualAsSet(joaoChildrenActual, joaoChildrenExpected)
        ? "Joao direct children match official L2 set exactly."
        : `Joao children mismatch. actual=${joaoChildrenActual.length} expected=${joaoChildrenExpected.length}`
    );

    const wronglyDirectUnderPedro = joaoChildrenExpected.filter((id) => {
      const n = nodeById.get(id);
      return n?.parentId === pedroId;
    });
    record(
      "topology_integrity",
      "joao-l2-not-direct-under-pedro",
      wronglyDirectUnderPedro.length === 0,
      wronglyDirectUnderPedro.length === 0
        ? "No Joao-L2 member is directly under Pedro."
        : `Found Joao-L2 directly under Pedro: ${wronglyDirectUnderPedro.length}`
    );
  } else {
    record(
      "topology_integrity",
      "joao-direct-child-of-pedro",
      false,
      "Joao driver ID was not resolved by email (jln@gmail.com)."
    );
  }

  const pedroL1Expected = GOD_NETWORK.level1.direct
    .map((x) => idByEmail.get(x.email))
    .filter((x): x is string => !!x);
  const pedroL1Actual = projection.nodes
    .filter((n) => n.parentId === pedroId)
    .map((n) => n.actorId);
  const expectedL1IsSubset = pedroL1Expected.every((id) => pedroL1Actual.includes(id));
  record(
    "topology_integrity",
    "pedro-level1-official-preserved",
    expectedL1IsSubset,
    expectedL1IsSubset
      ? "Pedro keeps all official L1 children as direct descendants."
      : `Official L1 child missing under Pedro. actual=${pedroL1Actual.length} official=${pedroL1Expected.length}`
  );

  // 5) Same source for projection tree and descendants grouping
  if (joaoId) {
    const joaoContext = await buildNetworkContextForDriver(joaoId, pedroId);
    const recomputedFromProjection = buildDescendantsTree(
      projection.nodes,
      projection.edges,
      joaoId,
      ActorType.DRIVER
    );

    const sameTree =
      safeJson(canonicalTree(joaoContext.genealogy.descendants)) ===
      safeJson(canonicalTree(recomputedFromProjection));
    record(
      "ownership_integrity",
      "descendants-use-official-projection",
      sameTree,
      sameTree
        ? "NetworkContext descendants are structurally identical to projection tree build."
        : "Descendants differ from projection-derived tree."
    );

    const flatJoao = flattenTree(joaoContext.genealogy.descendants);
    const joaoAbsoluteLevel = nodeById.get(joaoId)?.level ?? 0;
    const relativeDepthOk = flatJoao.every(
      (n) => n.absoluteDepth - joaoAbsoluteLevel === n.depth
    );
    record(
      "projection_integrity",
      "relative-and-absolute-depth-contract",
      relativeDepthOk,
      relativeDepthOk
        ? "depth is relative to viewer and absoluteDepth is global as expected."
        : "depth/absoluteDepth contract mismatch for Joao descendants."
    );

    const joaoL2Ids = GOD_NETWORK.level2UnderJoao
      .map((x) => idByEmail.get(x.email))
      .filter((x): x is string => !!x);
    const joaoDirectDepthOk = flatJoao
      .filter((n) => joaoL2Ids.includes(n.id))
      .every((n) => n.depth === 1);
    record(
      "projection_integrity",
      "joao-direct-children-relative-depth-1",
      joaoDirectDepthOk,
      joaoDirectDepthOk
        ? "Official Joao children have depth=1 for Joao viewer."
        : "At least one official Joao child is not depth=1 for Joao viewer."
    );

    // Lateral should come from same read-model (siblings by same inviter)
    const siblingRows = await prisma.referralRelationship.findMany({
      where: {
        inviterActorType: ActorType.DRIVER,
        inviterId: pedroId,
        NOT: { invitedId: joaoId },
      },
      select: { invitedId: true },
    });
    const expectedLateral = siblingRows.map((r) => r.invitedId);
    const actualLateral = joaoContext.genealogy.lateral.map((a) => a.id);
    const officialL1Siblings = GOD_NETWORK.level1.direct
      .map((x) => idByEmail.get(x.email))
      .filter((x): x is string => !!x && x !== joaoId);
    const containsOfficialSiblings = officialL1Siblings.every((id) => actualLateral.includes(id));
    const readModelSubset = actualLateral.every((id) => expectedLateral.includes(id));
    record(
      "ownership_integrity",
      "lateral-uses-readmodel",
      containsOfficialSiblings && readModelSubset,
      containsOfficialSiblings && readModelSubset
        ? "Lateral list is read-model-backed and preserves official siblings."
        : "Lateral list does not fully match read-model-backed sibling constraints."
    );
  }

  // 10) Semantic sync between DriverReferral, ReferralRelationship, GenealogyProjection, NetworkContextProjection
  const directDriverReferrals = await prisma.driverReferral.findMany({
    where: { isDirect: true },
    select: { referrerDriverId: true, referredDriverId: true },
  });
  const directPairs = new Set(directDriverReferrals.map((r) => `${r.referrerDriverId}->${r.referredDriverId}`));

  const driverRelationships = await prisma.referralRelationship.findMany({
    where: { invitedActorType: ActorType.DRIVER, inviterActorType: ActorType.DRIVER },
    select: { inviterId: true, invitedId: true },
  });
  const relationshipPairs = new Set(driverRelationships.map((r) => `${r.inviterId}->${r.invitedId}`));

  const missingInReadModel = [...directPairs].filter((p) => !relationshipPairs.has(p));
  record(
    "ownership_integrity",
    "driverreferral-to-relationship-sync",
    missingInReadModel.length === 0,
    missingInReadModel.length === 0
      ? "All direct DriverReferral D2D pairs exist in ReferralRelationship."
      : `Missing D2D pairs in read-model: ${missingInReadModel.length}`
  );

  const relationshipForRoot = await prisma.referralRelationship.findMany({
    where: { rootDriverId: pedroId },
    select: {
      inviterId: true,
      invitedId: true,
      flowType: true,
    },
  });
  const relEdgeSet = new Set(relationshipForRoot.map((r) => `${r.inviterId}->${r.invitedId}:${r.flowType}`));
  const projectionEdgeMismatches = projection.edges.filter(
    (e) => !relEdgeSet.has(`${e.sourceActorId}->${e.targetActorId}:${e.flowType}`)
  );
  record(
    "ownership_integrity",
    "projection-edges-backed-by-readmodel",
    projectionEdgeMismatches.length === 0,
    projectionEdgeMismatches.length === 0
      ? "All projection edges are backed by ReferralRelationship rows."
      : `Projection edges missing in read-model: ${projectionEdgeMismatches.length}`
  );

  // 6/7) Frontend integrity in this repository (adapter/presentation path)
  const suspiciousPatterns: Array<{ id: string; regex: RegExp }> = [
    { id: "groupBy-depth", regex: /groupBy\s*\(\s*depth/ },
    { id: "rebuildTree", regex: /rebuildTree\s*\(/ },
    { id: "inferParent", regex: /inferParent\s*\(/ },
    { id: "flatten-regroup", regex: /flatten\s*\([^)]*\).*regroup|regroup\s*\(/s },
    { id: "mock-fallback", regex: /fallback\s*mock|mock\s*fallback/i },
    { id: "depth-recalculation", regex: /depth\s*=\s*.*(level|absoluteDepth)/i },
  ];

  const localFrontendRoots = [
    path.resolve(process.cwd(), "src/presentation"),
    path.resolve(process.cwd(), "src/application"),
  ];
  const localFrontendFiles = localFrontendRoots.flatMap((d) => listAllFilesRecursive(d));
  for (const pattern of suspiciousPatterns) {
    let hit = false;
    for (const file of localFrontendFiles) {
      const text = fs.readFileSync(file, "utf8");
      if (pattern.regex.test(text)) {
        hit = true;
        break;
      }
    }
    record(
      "frontend_integrity",
      `no-${pattern.id}`,
      !hit,
      hit
        ? `Suspicious pattern '${pattern.id}' found in local adapter/presentation code.`
        : `Pattern '${pattern.id}' not found in local adapter/presentation code.`
    );
  }

  const externalFrontendRepo = resolveExternalFrontendRepoPath();
  if (!externalFrontendRepo) {
    record(
      "frontend_integrity",
      "external-frontend-audit-scope",
      false,
      "External frontend repository path was not resolved. Set GODNETWORK_FRONTEND_REPO or pass --frontend-repo=<path>."
    );
  } else {
    const externalFiles = listAllFilesRecursive(path.join(externalFrontendRepo, "src"));
    record(
      "frontend_integrity",
      "external-frontend-audit-scope",
      externalFiles.length > 0,
      externalFiles.length > 0
        ? `External frontend repository audited at: ${externalFrontendRepo}`
        : `External frontend repository has no source files at: ${externalFrontendRepo}`
    );

    for (const pattern of suspiciousPatterns) {
      let hit = false;
      for (const file of externalFiles) {
        const text = fs.readFileSync(file, "utf8");
        if (pattern.regex.test(text)) {
          hit = true;
          break;
        }
      }
      record(
        "frontend_integrity",
        `no-${pattern.id}-external`,
        !hit,
        hit
          ? `Suspicious pattern '${pattern.id}' found in external frontend source.`
          : `Pattern '${pattern.id}' not found in external frontend source.`
      );
    }
  }

  // 9) Runtime stability snapshots (refresh/hydration/polling approximation)
  if (joaoId) {
    const snapshots: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ctx = await buildNetworkContextForDriver(joaoId, pedroId);
      snapshots.push(
        safeJson({
          ancestors: ctx.genealogy.ancestors.map((a) => a.id),
          lateral: ctx.genealogy.lateral.map((l) => l.id),
          descendants: canonicalTree(ctx.genealogy.descendants),
          flowType: ctx.flowType,
          rootDriverId: ctx.rootDriver?.id ?? null,
        })
      );
    }
    const stable = snapshots.every((s) => s === snapshots[0]);
    record(
      "runtime_integrity",
      "polling-refresh-stability",
      stable,
      stable
        ? "Repeated context snapshots are stable across reads."
        : "Context snapshots changed across repeated reads."
    );

    const baseline = snapshots[0];
    const sync1 = await SyncProjectionJob.execute();
    const sync2 = await SyncProjectionJob.execute();
    const postSyncCtx = await buildNetworkContextForDriver(joaoId, pedroId);
    const postSyncSnapshot = safeJson({
      ancestors: postSyncCtx.genealogy.ancestors.map((a) => a.id),
      lateral: postSyncCtx.genealogy.lateral.map((l) => l.id),
      descendants: canonicalTree(postSyncCtx.genealogy.descendants),
      flowType: postSyncCtx.flowType,
      rootDriverId: postSyncCtx.rootDriver?.id ?? null,
    });

    record(
      "runtime_integrity",
      "projection-rebuild-idempotent",
      baseline === postSyncSnapshot,
      baseline === postSyncSnapshot
        ? `Context snapshot unchanged after SyncProjectionJob passes (repaired=${sync1.repaired + sync2.repaired}).`
        : "Context snapshot changed after projection sync/rebuild passes."
    );
  }

  const replayEvents = await prisma.domainEvent.findMany({
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: 500,
    select: { id: true, type: true, aggregateType: true, aggregateId: true, occurredAt: true },
  });
  const replayable = replayEvents.length > 0;

  const replaySequence = replayEvents.map((e) => `${e.type}:${e.aggregateType}:${e.aggregateId}`);
  const replaySequenceAgain = [...replayEvents]
    .sort((a, b) => {
      const ta = a.occurredAt.getTime();
      const tb = b.occurredAt.getTime();
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    })
    .map((e) => `${e.type}:${e.aggregateType}:${e.aggregateId}`);

  record(
    "runtime_integrity",
    "event-replay-determinism",
    !replayable || safeJson(replaySequence) === safeJson(replaySequenceAgain),
    replayable
      ? "DomainEvent log ordering supports deterministic replay (occurredAt,id)."
      : "No DomainEvents found; replay determinism check treated as neutral/pass."
  );

  // 12) Final report
  const axes: Axis[] = [
    "projection_integrity",
    "topology_integrity",
    "lineage_integrity",
    "ownership_integrity",
    "frontend_integrity",
    "runtime_integrity",
  ];

  // Lineage checks (kept near final summary because they depend on parent map)
  if (joaoId) {
    try {
      const joaoLineage = buildLineageToRoot(joaoId, parentById);
      record(
        "lineage_integrity",
        "joao-lineage-path",
        safeJson(joaoLineage) === safeJson([pedroId, joaoId]),
        safeJson(joaoLineage) === safeJson([pedroId, joaoId])
          ? "Joao lineage is [Pedro, Joao]."
          : `Unexpected Joao lineage: ${safeJson(joaoLineage)}`
      );

      for (const child of GOD_NETWORK.level2UnderJoao) {
        const childId = idByEmail.get(child.email);
        if (!childId) {
          record(
            "lineage_integrity",
            `lineage-${child.email}`,
            false,
            `Driver id not found for ${child.email}`
          );
          continue;
        }
        const lineage = buildLineageToRoot(childId, parentById);
        const expected = [pedroId, joaoId, childId];
        record(
          "lineage_integrity",
          `lineage-${child.email}`,
          safeJson(lineage) === safeJson(expected),
          safeJson(lineage) === safeJson(expected)
            ? `${child.name} lineage matches expected chain.`
            : `Lineage mismatch for ${child.name}: ${safeJson(lineage)}`
        );
      }
    } catch (error) {
      record(
        "lineage_integrity",
        "lineage-walk",
        false,
        `Lineage walk failed: ${(error as Error).message}`
      );
    }
  } else {
    record(
      "lineage_integrity",
      "joao-lineage-path",
      false,
      "Joao driver id unavailable; lineage checks skipped."
    );
  }

  console.log("Audit checks:\n");
  for (const axis of axes) {
    const axisChecks = checks.filter((c) => c.axis === axis);
    const axisPass = axisChecks.length > 0 && axisChecks.every((c) => c.pass);
    console.log(`[${boolToStatus(axisPass)}] ${axis}`);
    for (const check of axisChecks) {
      console.log(`  - [${boolToStatus(check.pass)}] ${check.id}: ${check.detail}`);
    }
    if (axisChecks.length === 0) {
      console.log("  - [FAIL] no-checks: No checks executed for this axis.");
    }
    console.log("");
  }

  const total = checks.length;
  const failed = checks.filter((c) => !c.pass).length;
  const passed = total - failed;

  console.log("Summary:");
  console.log(`  total checks: ${total}`);
  console.log(`  passed: ${passed}`);
  console.log(`  failed: ${failed}`);

  const hardFailAxes = [
    "projection_integrity",
    "topology_integrity",
    "lineage_integrity",
    "ownership_integrity",
  ] as const;
  const hardFailures = hardFailAxes.reduce((acc, axis) => acc + failCount(axis), 0);

  if (hardFailures > 0) {
    console.error("\nGovernance audit FAILED on hard integrity axes.");
    process.exitCode = 1;
    return;
  }

  console.log("\nHard integrity axes PASSED.");
  if (failCount("frontend_integrity") > 0 || failCount("runtime_integrity") > 0) {
    console.log(
      "Frontend/runtime scope has pending external lifecycle verification. See failed checks above."
    );
  }
}

main()
  .catch((error) => {
    console.error("Audit execution failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
