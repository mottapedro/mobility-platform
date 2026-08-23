/**
 * Smoke test: full passenger → passenger referral flow via HTTP.
 *
 * Exercises the complete happy-path:
 *   1. Register Alice → receives auto-generated referralCode + publicSlug
 *   2. Register Bob with Alice's referralCode → Bob is level-1 under Alice
 *   3. GET /passengers/:id/network → Bob appears in Alice's level1
 *   4. GET /passengers/ref/:slug → resolves Alice by publicSlug
 *   5. Hierarchy endpoint → Alice's hierarchy shows Bob
 */

import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";

jest.setTimeout(20000);

describe("smoke: passenger → passenger referral full flow", () => {
  it("registers Alice, registers Bob via Alice code, network and slug all consistent", async () => {
    // ── 1. Register Alice ─────────────────────────────────────────────────
    const rootDriverRes = await request(app).post("/auth/register").send({
      name: "Pedro Smoke Root",
      email: "pedro-smoke-root@ptest.com",
      password: "senha123",
      role: "driver",
      phone: "21900000000",
      regions: ["ZN"],
    });

    expect(rootDriverRes.status).toBe(201);
    const rootDriverId: string = rootDriverRes.body.driverId;
    const rootDriverCode: string = rootDriverRes.body.referralCode;

    const aliceRes = await request(app).post("/auth/register").send({
      name: "Alice Smoke",
      email: "alice-smoke@ptest.com",
      password: "senha123",
      role: "passenger",
      phone: "21900000001",
      referralCode: rootDriverCode,
    });

    expect(aliceRes.status).toBe(201);
    expect(aliceRes.body.referralCode).toMatch(/^[a-z0-9-]+-[a-z0-9]{4}$/);
    expect(aliceRes.body.publicSlug).toMatch(/^alice-smoke/);
    expect(aliceRes.body.passengerId).toBeDefined();

    const aliceId: string = aliceRes.body.passengerId;
    const aliceCode: string = aliceRes.body.referralCode;
    const aliceSlug: string = aliceRes.body.publicSlug;

    const aliceRecord = await prisma.passenger.findUniqueOrThrow({
      where: { id: aliceId },
    });
    expect(aliceRecord.rootDriverId).toBe(rootDriverId);

    // ── 2. Register Bob using Alice's referralCode ─────────────────────────
    const bobRes = await request(app).post("/auth/register").send({
      name: "Bob Smoke",
      email: "bob-smoke@ptest.com",
      password: "senha123",
      role: "passenger",
      phone: "21900000002",
      referralCode: aliceCode,
    });

    expect(bobRes.status).toBe(201);
    expect(bobRes.body.referralCode).toMatch(/^[a-z0-9-]+-[a-z0-9]{4}$/);
    expect(bobRes.body.publicSlug).toMatch(/^bob-smoke/);

    const bobId: string = bobRes.body.passengerId;

    // Verify Bob is linked to Alice in DB
    const bobRecord = await prisma.passenger.findUniqueOrThrow({ where: { id: bobId } });
    expect(bobRecord.referredByPassengerId).toBe(aliceId);
    expect(bobRecord.networkLevel).toBe(1);

    // ── 3. Alice's network shows Bob at level1 ────────────────────────────
    const networkRes = await request(app).get(`/passengers/${aliceId}/network`);
    expect(networkRes.status).toBe(200);
    expect(networkRes.body.level1).toContain(bobId);
    expect(networkRes.body.totalReferrals).toBeGreaterThanOrEqual(1);

    // ── 4. Resolve Alice by public slug ───────────────────────────────────
    const slugRes = await request(app).get(`/passengers/ref/${aliceSlug}`);
    expect(slugRes.status).toBe(200);
    expect(slugRes.body.id).toBe(aliceId);
    expect(slugRes.body.referralCode).toBe(aliceCode);
    expect(slugRes.body.publicSlug).toBe(aliceSlug);

    // ── 5. Hierarchy shows Alice as root, Bob as referral ─────────────────
    const hierarchyRes = await request(app).get(`/passengers/${aliceId}/network/hierarchy`);
    expect(hierarchyRes.status).toBe(200);
    expect(hierarchyRes.body.me.id).toBe(aliceId);
    const referralIds = hierarchyRes.body.referrals.map((r: { id: string }) => r.id);
    expect(referralIds).toContain(bobId);
  });
});
