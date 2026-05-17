import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";
import { createPassengerReferral } from "../src/domain/services/PassengerReferralService";

jest.setTimeout(15000);

async function createPassenger(email: string, name = email) {
  return prisma.passenger.create({
    data: {
      user: {
        create: {
          name,
          email,
          phone: "11900000002",
          role: "PASSENGER",
        },
      },
    },
    include: { user: true },
  });
}

describe("GET /passengers/:id/network/hierarchy", () => {
  it("returns 404 for a passenger that does not exist", async () => {
    const res = await request(app).get(
      "/passengers/00000000-0000-0000-0000-000000000000/network/hierarchy"
    );
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns correct shape for a root passenger with no referrals", async () => {
    const p = await createPassenger("hier-root@ptest.com", "Root User");

    const res = await request(app).get(`/passengers/${p.id}/network/hierarchy`);

    expect(res.status).toBe(200);
    expect(res.body.me).toHaveProperty("id", p.id);
    expect(res.body.me).toHaveProperty("name", "Root User");
    expect(res.body.me).toHaveProperty("networkLevel", 0);
    expect(res.body.referredBy).toBeNull();
    expect(res.body.referrals).toHaveLength(0);
    expect(res.body.totalPassengers).toBe(1);
    expect(res.body.maxDepth).toBe(0);
  });

  it("reflects referredBy when passenger was referred", async () => {
    const root = await createPassenger("hier-ref@ptest.com", "Alice");
    const child = await createPassenger("hier-child@ptest.com", "Bob");

    await createPassengerReferral(child.id, root.id);

    const res = await request(app).get(`/passengers/${child.id}/network/hierarchy`);

    expect(res.status).toBe(200);
    expect(res.body.referredBy).not.toBeNull();
    expect(res.body.referredBy.id).toBe(root.id);
  });

  it("includes direct referrals in referrals[] and correct totalPassengers", async () => {
    const root = await createPassenger("hier-r@ptest.com", "Root");
    const a = await createPassenger("hier-a@ptest.com", "A");
    const b = await createPassenger("hier-b@ptest.com", "B");

    await createPassengerReferral(a.id, root.id);
    await createPassengerReferral(b.id, root.id);

    const res = await request(app).get(`/passengers/${root.id}/network/hierarchy`);

    expect(res.status).toBe(200);
    expect(res.body.referrals).toHaveLength(2);
    const ids = res.body.referrals.map((r: { id: string }) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(res.body.totalPassengers).toBe(3); // root + a + b
    expect(res.body.maxDepth).toBe(1);
  });

  it("reports maxDepth 2 for a 3-level chain", async () => {
    const root = await createPassenger("md-root@ptest.com", "Root");
    const l1 = await createPassenger("md-l1@ptest.com", "L1");
    const l2 = await createPassenger("md-l2@ptest.com", "L2");

    await createPassengerReferral(l1.id, root.id);
    await createPassengerReferral(l2.id, l1.id);

    const res = await request(app).get(`/passengers/${root.id}/network/hierarchy`);

    expect(res.status).toBe(200);
    expect(res.body.maxDepth).toBe(2);
    expect(res.body.totalPassengers).toBe(3);
  });
});
