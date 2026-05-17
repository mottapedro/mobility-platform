import http from "http";

function post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts: http.RequestOptions = {
      hostname: "localhost", port: 3000, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    const req = http.request(opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(d) }));
    });
    req.on("error", reject); req.write(data); req.end();
  });
}

function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "localhost", port: 3000, path }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(d) }));
    }).on("error", reject);
  });
}

import { prisma } from "../src/infra/prisma/client";

async function smoke() {
  console.log("\n🔵 SMOKE TEST: passenger → passenger referral flow\n");

  // 1. Register Alice — gets auto-generated codes
  const alice = await post("/auth/register", {
    name: "Alice Smoke", email: "alice-smoke@ptest.com",
    password: "senha123", role: "passenger", phone: "21900000001",
  });
  console.log(`[1] Alice register: HTTP ${alice.status}`);
  console.log(`    passengerId: ${alice.body.passengerId}`);
  console.log(`    referralCode: ${alice.body.referralCode}`);
  console.log(`    publicSlug: ${alice.body.publicSlug}`);

  if (alice.status !== 201 || !alice.body.referralCode) {
    throw new Error("Alice registration failed or missing referralCode");
  }

  const aliceCode = alice.body.referralCode as string;
  const aliceId = alice.body.passengerId as string;

  // 2. Register Bob using Alice's referralCode
  const bob = await post("/auth/register", {
    name: "Bob Smoke", email: "bob-smoke@ptest.com",
    password: "senha123", role: "passenger", phone: "21900000002",
    referralCode: aliceCode,
  });
  console.log(`\n[2] Bob register: HTTP ${bob.status}`);
  console.log(`    passengerId: ${bob.body.passengerId}`);
  console.log(`    referralCode: ${bob.body.referralCode}`);
  console.log(`    publicSlug: ${bob.body.publicSlug}`);

  if (bob.status !== 201) throw new Error("Bob registration failed");

  // Verify Bob's referredByPassengerId in DB
  const bobRecord = await prisma.passenger.findUnique({ where: { id: bob.body.passengerId as string } });
  console.log(`    referredByPassengerId: ${bobRecord?.referredByPassengerId}`);
  console.log(`    networkLevel: ${bobRecord?.networkLevel}`);
  if (bobRecord?.referredByPassengerId !== aliceId) throw new Error("Bob's referredByPassengerId is wrong");
  if (bobRecord?.networkLevel !== 1) throw new Error("Bob's networkLevel should be 1");

  // 3. GET /passengers/:id/network for Alice — Bob should be level1
  const network = await get(`/passengers/${aliceId}/network`);
  console.log(`\n[3] Alice network: HTTP ${network.status}`);
  console.log(`    totalReferrals: ${(network.body as any).totalReferrals}`);
  console.log(`    level1: ${JSON.stringify((network.body as any).level1)}`);
  if (!(network.body as any).level1?.includes(bob.body.passengerId as string)) {
    throw new Error("Bob not found in Alice's level1 network");
  }

  // 4. GET /passengers/ref/:slug — resolves Alice by publicSlug
  const slugRes = await get(`/passengers/ref/${alice.body.publicSlug}`);
  console.log(`\n[4] Slug lookup for '${alice.body.publicSlug}': HTTP ${slugRes.status}`);
  console.log(`    id: ${(slugRes.body as any).id}`);
  if ((slugRes.body as any).id !== aliceId) throw new Error("Slug did not resolve to Alice");

  console.log("\n✅ ALL SMOKE CHECKS PASSED\n");
}

smoke()
  .catch((err) => { console.error("\n❌ SMOKE FAILED:", err.message); process.exit(1); })
  .finally(async () => {
    // Clean up test data
    await prisma.passenger.updateMany({
      where: { user: { email: { in: ["alice-smoke@ptest.com", "bob-smoke@ptest.com"] } } },
      data: { referredByPassengerId: null },
    });
    await prisma.passenger.deleteMany({
      where: { user: { email: { in: ["alice-smoke@ptest.com", "bob-smoke@ptest.com"] } } },
    });
    await prisma.user.deleteMany({
      where: { email: { in: ["alice-smoke@ptest.com", "bob-smoke@ptest.com"] } },
    });
    await prisma.$disconnect();
    console.log("🧹 Test data cleaned up.");
  });
