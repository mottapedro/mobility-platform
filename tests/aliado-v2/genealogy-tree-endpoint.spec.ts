/**
 * Spec: genealogy-tree-endpoint
 *
 * Integration tests for GET /drivers/:id/network/genealogy
 *
 * Uses real DB helpers; all records use @test.com domain.
 * Production data (Pedro Paulo Motta, etc.) is never touched.
 *
 * Response shape (GenealogyTypes.ts):
 *   { rootDriver, stats, nodes, edges, levels, metrics }
 *   levels: Array<{ depth: number; nodeIds: string[] }>
 *
 * Coverage:
 *  - 404 when driver does not exist
 *  - 400 when maxDepth > 10
 *  - 400 when maxDepth is not an integer
 *  - 200 for a root driver with no referrals → single node, no edges
 *  - 200 for root with D2D child → 2 nodes, 1 edge
 *  - Response shape: rootDriver, stats, nodes, edges, levels, metrics
 *  - Query param ?maxDepth=1 is honoured
 *  - Query param ?maxDepth=0 returns only root node
 */

import request from "supertest";
import bcrypt from "bcrypt";
import { ExperienceLevel } from "../../src/shared/enums";
import { prisma, cleanTestData } from "../setup";
import { app } from "../../src/app";
import { recordRelationship } from "../../src/domain/referral-network/ReferralRelationshipService";
import { ActorType } from "../../src/shared/enums";

async function makeDriver(
  email: string,
  level: ExperienceLevel = ExperienceLevel.PROFISSIONAL
) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: {
      userId: u.id,
      isActive: true,
      experienceLevel: level,
      regions: ["ZN"],
      referralCode: `rc-${u.id.slice(0, 8)}`,
      publicSlug: `slug-${u.id.slice(0, 8)}`,
    },
  });
}

async function makePassenger(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.passenger.create({
    data: { userId: u.id, networkLevel: 0 },
  });
}

beforeEach(cleanTestData);

describe("GET /drivers/:id/network/genealogy", () => {
  it("returns 404 when driver does not exist", async () => {
    const res = await request(app).get(
      "/drivers/00000000-0000-0000-0000-000000000000/network/genealogy"
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 when maxDepth > 10", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const root = await makeDriver(`gte.cap.${tag}@test.com`);
    const res = await request(app).get(`/drivers/${root.id}/network/genealogy?maxDepth=11`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maxDepth/i);
  });

  it("returns 400 when maxDepth is not an integer", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const root = await makeDriver(`gte.nan.${tag}@test.com`);
    const res = await request(app).get(`/drivers/${root.id}/network/genealogy?maxDepth=abc`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maxDepth/i);
  });

  it("returns 200 for a root driver with no referrals: single node, no edges", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const root = await makeDriver(`gte.root.${tag}@test.com`, ExperienceLevel.ELITE);

    const res = await request(app).get(`/drivers/${root.id}/network/genealogy`);
    expect(res.status).toBe(200);

    const body = res.body;
    // rootDriver object
    expect(body.rootDriver.id).toBe(root.id);
    expect(typeof body.rootDriver.name).toBe("string");
    // nodes / edges / levels / metrics / stats
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(Array.isArray(body.levels)).toBe(true);
    expect(typeof body.metrics).toBe("object");
    expect(typeof body.stats).toBe("object");

    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].actorId).toBe(root.id);
    expect(body.nodes[0].level).toBe(0);
    expect(body.nodes[0].parentId).toBeNull();
    expect(body.edges).toHaveLength(0);
    expect(body.metrics.totalDrivers).toBe(1);
    expect(body.metrics.totalPassengers).toBe(0);
    expect(body.metrics.maxDepth).toBe(0);
    // levels shape uses depth + nodeIds
    expect(body.levels[0].depth).toBe(0);
    expect(body.levels[0].nodeIds).toContain(root.id);
  });

  it("returns 200 for root with D2D child: 2 nodes, 1 edge, 2 levels", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const root = await makeDriver(`gte.r.${tag}@test.com`, ExperienceLevel.ELITE);
    const child = await makeDriver(`gte.c.${tag}@test.com`, ExperienceLevel.PROFISSIONAL);

    await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedActorType: ActorType.DRIVER,
      invitedId: child.id,
    });

    const res = await request(app).get(`/drivers/${root.id}/network/genealogy`);
    expect(res.status).toBe(200);

    const { nodes, edges, levels, metrics } = res.body;
    expect(nodes).toHaveLength(2);

    const childNode = nodes.find((n: any) => n.actorId === child.id);
    expect(childNode).toBeDefined();
    expect(childNode.level).toBe(1);
    expect(childNode.parentId).toBe(root.id);

    expect(edges).toHaveLength(1);
    expect(edges[0].sourceActorId).toBe(root.id);
    expect(edges[0].targetActorId).toBe(child.id);

    expect(levels).toHaveLength(2);
    expect(levels[0].depth).toBe(0);
    expect(levels[1].depth).toBe(1);
    expect(levels[1].nodeIds).toContain(child.id);

    expect(metrics.totalDrivers).toBe(2);
    expect(metrics.totalD2D).toBe(1);
    expect(metrics.maxDepth).toBe(1);
  });

  it("rebases a non-root driver over the global projection and preserves mixed-role descendants", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const pedro = await makeDriver(`gte.relative.root.${tag}@test.com`, ExperienceLevel.ELITE);
    const joao = await makeDriver(`gte.relative.joao.${tag}@test.com`, ExperienceLevel.PROFISSIONAL);
    const gisele = await makeDriver(`gte.relative.gisele.${tag}@test.com`, ExperienceLevel.PROFISSIONAL);
    const passenger = await makePassenger(`gte.relative.passenger.${tag}@test.com`);

    await prisma.driver.update({ where: { id: joao.id }, data: { referredByDriverId: pedro.id } });
    await prisma.driver.update({ where: { id: gisele.id }, data: { referredByDriverId: joao.id } });
    await recordRelationship({ inviterActorType: ActorType.DRIVER, inviterId: pedro.id, invitedActorType: ActorType.DRIVER, invitedId: joao.id });
    await recordRelationship({ inviterActorType: ActorType.DRIVER, inviterId: joao.id, invitedActorType: ActorType.DRIVER, invitedId: gisele.id });
    await recordRelationship({ inviterActorType: ActorType.DRIVER, inviterId: joao.id, invitedActorType: ActorType.PASSENGER, invitedId: passenger.id });

    const res = await request(app).get(`/drivers/${joao.id}/network/genealogy`);
    expect(res.status).toBe(200);
    expect(res.body.rootDriver.id).toBe(joao.id);
    expect(res.body.nodes.map((node: any) => node.actorId)).toEqual([joao.id, gisele.id, passenger.id]);
    expect(res.body.nodes.find((node: any) => node.actorId === joao.id)).toMatchObject({ level: 0, parentId: null, rootDriverId: pedro.id });
    expect(res.body.nodes.find((node: any) => node.actorId === gisele.id)).toMatchObject({ level: 1, parentId: joao.id, actorType: ActorType.DRIVER });
    expect(res.body.nodes.find((node: any) => node.actorId === passenger.id)).toMatchObject({ level: 1, parentId: joao.id, actorType: ActorType.PASSENGER });
    expect(res.body.levels).toEqual([
      { depth: 0, nodeIds: [joao.id] },
      { depth: 1, nodeIds: [gisele.id, passenger.id] },
    ]);
    expect(res.body.metrics).toMatchObject({ totalDrivers: 2, totalPassengers: 1, totalD2D: 1, totalD2P: 1, maxDepth: 1 });
    expect(res.body.nodes.some((node: any) => node.actorId === pedro.id)).toBe(false);

    const persisted = await prisma.referralRelationship.findMany({
      where: { rootDriverId: pedro.id },
      orderBy: { createdAt: "asc" },
    });
    expect(persisted).toHaveLength(3);
    expect(persisted.every((relationship) => relationship.rootDriverId === pedro.id)).toBe(true);
  });

  it("?maxDepth=0 returns only the root node", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const root = await makeDriver(`gte.md0.${tag}@test.com`, ExperienceLevel.ELITE);
    const child = await makeDriver(`gte.md0.c.${tag}@test.com`, ExperienceLevel.PROFISSIONAL);

    await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedActorType: ActorType.DRIVER,
      invitedId: child.id,
    });

    const res = await request(app).get(`/drivers/${root.id}/network/genealogy?maxDepth=0`);
    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.nodes[0].actorId).toBe(root.id);
    expect(res.body.edges).toHaveLength(0);
    expect(res.body.stats.appliedDepthLimit).toBe(0);
  });

  it("?maxDepth=1 limits tree to depth 1 only", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const root = await makeDriver(`gte.md1.r.${tag}@test.com`, ExperienceLevel.ELITE);
    const mid = await makeDriver(`gte.md1.m.${tag}@test.com`);
    const leaf = await makeDriver(`gte.md1.l.${tag}@test.com`);

    await recordRelationship({ inviterActorType: ActorType.DRIVER, inviterId: root.id, invitedActorType: ActorType.DRIVER, invitedId: mid.id });
    await recordRelationship({ inviterActorType: ActorType.DRIVER, inviterId: mid.id, invitedActorType: ActorType.DRIVER, invitedId: leaf.id });

    const res = await request(app).get(`/drivers/${root.id}/network/genealogy?maxDepth=1`);
    expect(res.status).toBe(200);

    // leaf is at depth 2, should be excluded
    const nodeIds = res.body.nodes.map((n: any) => n.actorId);
    expect(nodeIds).toContain(root.id);
    expect(nodeIds).toContain(mid.id);
    expect(nodeIds).not.toContain(leaf.id);
    expect(res.body.stats.appliedDepthLimit).toBe(1);
  });

  it("response nodes all have required fields", async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const root = await makeDriver(`gte.fields.${tag}@test.com`, ExperienceLevel.ELITE);

    const res = await request(app).get(`/drivers/${root.id}/network/genealogy`);
    expect(res.status).toBe(200);

    for (const node of res.body.nodes) {
      expect(node).toHaveProperty("actorId");
      expect(node).toHaveProperty("actorType");
      expect(node).toHaveProperty("name");
      expect(node).toHaveProperty("level");
      expect(node).toHaveProperty("rootDriverId");
      expect(node).toHaveProperty("parentId");
      expect(node).toHaveProperty("createdAt");
      expect(node).toHaveProperty("networkLevel");
    }
  });
});

