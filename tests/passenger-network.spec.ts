import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";
import { createPassengerReferral } from "../src/domain/services/PassengerReferralService";

jest.setTimeout(15000);

async function createPassenger(email: string) {
  return prisma.passenger.create({
    data: {
      user: {
        create: {
          name: email,
          email,
          phone: "11900000001",
          role: "PASSENGER",
        },
      },
    },
    include: { user: true },
  });
}

describe("GET /passengers/:id/network", () => {
  it("returns 404 for a passenger that does not exist", async () => {
    const res = await request(app).get("/passengers/00000000-0000-0000-0000-000000000000/network");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns zero stats for a passenger with no referrals", async () => {
    const p = await createPassenger("net-zero@ptest.com");

    const res = await request(app).get(`/passengers/${p.id}/network`);

    expect(res.status).toBe(200);
    expect(res.body.totalReferrals).toBe(0);
    expect(res.body.level1).toHaveLength(0);
    expect(res.body.level2).toHaveLength(0);
    expect(res.body.level3).toHaveLength(0);
    expect(Array.isArray(res.body.recentReferrals)).toBe(true);
  });

  it("counts level1 referrals correctly", async () => {
    const referrer = await createPassenger("net-ref@ptest.com");
    const a = await createPassenger("net-a@ptest.com");
    const b = await createPassenger("net-b@ptest.com");

    await createPassengerReferral(a.id, referrer.id);
    await createPassengerReferral(b.id, referrer.id);

    const res = await request(app).get(`/passengers/${referrer.id}/network`);

    expect(res.status).toBe(200);
    expect(res.body.totalReferrals).toBe(2);
    expect(res.body.level1).toHaveLength(2);
    expect(res.body.level1).toContain(a.id);
    expect(res.body.level1).toContain(b.id);
    expect(res.body.level2).toHaveLength(0);
  });

  it("counts a 3-level chain correctly", async () => {
    const root = await createPassenger("chain-root@ptest.com");
    const l1 = await createPassenger("chain-l1@ptest.com");
    const l2 = await createPassenger("chain-l2@ptest.com");
    const l3 = await createPassenger("chain-l3@ptest.com");

    await createPassengerReferral(l1.id, root.id);
    await createPassengerReferral(l2.id, l1.id);
    await createPassengerReferral(l3.id, l2.id);

    const res = await request(app).get(`/passengers/${root.id}/network`);

    expect(res.status).toBe(200);
    expect(res.body.totalReferrals).toBe(3);
    expect(res.body.level1).toEqual([l1.id]);
    expect(res.body.level2).toEqual([l2.id]);
    expect(res.body.level3).toEqual([l3.id]);
  });

  it("recentReferrals contains name and createdAt of level1 passengers", async () => {
    const referrer = await createPassenger("recent-ref@ptest.com");
    const child = await createPassenger("recent-child@ptest.com");

    await createPassengerReferral(child.id, referrer.id);

    const res = await request(app).get(`/passengers/${referrer.id}/network`);

    expect(res.status).toBe(200);
    expect(res.body.recentReferrals).toHaveLength(1);
    expect(res.body.recentReferrals[0]).toHaveProperty("id", child.id);
    expect(res.body.recentReferrals[0]).toHaveProperty("name");
    expect(res.body.recentReferrals[0]).toHaveProperty("createdAt");
  });
});
