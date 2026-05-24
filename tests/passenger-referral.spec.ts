import { prisma } from "./setup";
import {
  generatePassengerReferralCode,
  resolvePassengerReferralCode,
  createPassengerReferral,
  getPassengerNetwork,
  validateNoLoop,
  assignPassengerIdentity,
} from "../src/domain/services/PassengerReferralService";

jest.setTimeout(15000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createPassenger(email: string) {
  const slug = `pref-${email.replace(/[@.]/g, "-")}-${Date.now()}`;
  return prisma.passenger.create({
    data: {
      referralCode: slug,
      publicSlug: slug,
      user: {
        create: {
          name: email,
          email,
          phone: "11988880000",
          role: "PASSENGER",
        },
      },
    },
    include: { user: true },
  });
}

// ─── generatePassengerReferralCode ────────────────────────────────────────────

describe("generatePassengerReferralCode", () => {
  it("returns a lowercase slug with a 4-char alphanumeric suffix", () => {
    const passenger = {
      id: "fake-id-1",
      user: { name: "Maria Silva" },
    } as Parameters<typeof generatePassengerReferralCode>[0];

    const code = generatePassengerReferralCode(passenger);

    // e.g. "maria-silva-ab12"
    expect(code).toMatch(/^[a-z0-9-]+-[a-z0-9]{4}$/);
    expect(code).toContain("maria");
  });

  it("returns different codes on successive calls for the same name", () => {
    const passenger = {
      id: "fake-id-2",
      user: { name: "João Souza" },
    } as Parameters<typeof generatePassengerReferralCode>[0];

    const code1 = generatePassengerReferralCode(passenger);
    const code2 = generatePassengerReferralCode(passenger);

    // Collisions are astronomically unlikely (36^4 = 1,679,616 possibilities)
    expect(code1).not.toBe(code2);
  });
});

// ─── resolvePassengerReferralCode ─────────────────────────────────────────────

describe("resolvePassengerReferralCode", () => {
  it("returns null for an unknown code", async () => {
    const result = await resolvePassengerReferralCode("nonexistent-code-zzzz");
    expect(result).toBeNull();
  });

  it("returns the passenger whose referralCode matches", async () => {
    const p = await createPassenger("resolve-test@ptest.com");
    const code = generatePassengerReferralCode(p);
    await prisma.passenger.update({
      where: { id: p.id },
      data: { referralCode: code },
    });

    const result = await resolvePassengerReferralCode(code);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(p.id);
  });
});

// ─── validateNoLoop ───────────────────────────────────────────────────────────

describe("validateNoLoop", () => {
  it("does not throw when there is no loop", async () => {
    const referrer = await createPassenger("loop-safe-ref@ptest.com");
    const newP = await createPassenger("loop-safe-new@ptest.com");

    await expect(validateNoLoop(newP.id, referrer.id)).resolves.not.toThrow();
  });

  it("throws when newId equals referrerId (self-referral)", async () => {
    const p = await createPassenger("self-ref@ptest.com");

    await expect(validateNoLoop(p.id, p.id)).rejects.toThrow("loop");
  });

  it("throws when referrer's lineagePath already contains newId", async () => {
    const root = await createPassenger("loop-root@ptest.com");
    const mid = await createPassenger("loop-mid@ptest.com");
    const leaf = await createPassenger("loop-leaf@ptest.com");

    // Build chain: root → mid → leaf
    await createPassengerReferral(mid.id, root.id);
    await createPassengerReferral(leaf.id, mid.id);

    // Attempting to make root refer to leaf creates a cycle
    await expect(validateNoLoop(root.id, leaf.id)).rejects.toThrow("loop");
  });
});

// ─── createPassengerReferral ──────────────────────────────────────────────────

describe("createPassengerReferral", () => {
  it("sets referredByPassengerId on the new passenger", async () => {
    const referrer = await createPassenger("referrer-a@ptest.com");
    const newP = await createPassenger("new-a@ptest.com");

    await createPassengerReferral(newP.id, referrer.id);

    const updated = await prisma.passenger.findUniqueOrThrow({ where: { id: newP.id } });
    expect(updated.referredByPassengerId).toBe(referrer.id);
  });

  it("sets networkLevel to 1 for a direct referral", async () => {
    const referrer = await createPassenger("referrer-b@ptest.com");
    const newP = await createPassenger("new-b@ptest.com");

    await createPassengerReferral(newP.id, referrer.id);

    const updated = await prisma.passenger.findUniqueOrThrow({ where: { id: newP.id } });
    expect(updated.networkLevel).toBe(1);
  });

  it("sets rootPassengerId to the referrer when referrer is root", async () => {
    const referrer = await createPassenger("referrer-c@ptest.com");
    const newP = await createPassenger("new-c@ptest.com");

    await createPassengerReferral(newP.id, referrer.id);

    const updated = await prisma.passenger.findUniqueOrThrow({ where: { id: newP.id } });
    expect(updated.rootPassengerId).toBe(referrer.id);
  });

  it("inherits rootPassengerId from the referrer when referrer is not root", async () => {
    const root = await createPassenger("root-d@ptest.com");
    const mid = await createPassenger("mid-d@ptest.com");
    const leaf = await createPassenger("leaf-d@ptest.com");

    await createPassengerReferral(mid.id, root.id);
    await createPassengerReferral(leaf.id, mid.id);

    const leafRow = await prisma.passenger.findUniqueOrThrow({ where: { id: leaf.id } });
    expect(leafRow.rootPassengerId).toBe(root.id);
    expect(leafRow.networkLevel).toBe(2);
  });

  it("appends newPassengerId to lineagePath", async () => {
    const root = await createPassenger("lp-root@ptest.com");
    const mid = await createPassenger("lp-mid@ptest.com");
    const leaf = await createPassenger("lp-leaf@ptest.com");

    await createPassengerReferral(mid.id, root.id);
    await createPassengerReferral(leaf.id, mid.id);

    const leafRow = await prisma.passenger.findUniqueOrThrow({ where: { id: leaf.id } });
    expect(leafRow.lineagePath).toContain(root.id);
    expect(leafRow.lineagePath).toContain(mid.id);
    expect(leafRow.lineagePath).toContain(leaf.id);
    expect(leafRow.lineagePath[leafRow.lineagePath.length - 1]).toBe(leaf.id);
  });
});

// ─── getPassengerNetwork ──────────────────────────────────────────────────────

describe("getPassengerNetwork", () => {
  it("returns empty arrays for a passenger with no referrals", async () => {
    const p = await createPassenger("net-empty@ptest.com");

    const network = await getPassengerNetwork(p.id);

    expect(network.level1).toHaveLength(0);
    expect(network.level2).toHaveLength(0);
    expect(network.level3).toHaveLength(0);
  });

  it("counts two direct referrals as level1", async () => {
    const referrer = await createPassenger("net-ref@ptest.com");
    const a = await createPassenger("net-a@ptest.com");
    const b = await createPassenger("net-b@ptest.com");

    await createPassengerReferral(a.id, referrer.id);
    await createPassengerReferral(b.id, referrer.id);

    const network = await getPassengerNetwork(referrer.id);

    expect(network.level1).toHaveLength(2);
    expect(network.level1).toContain(a.id);
    expect(network.level1).toContain(b.id);
    expect(network.level2).toHaveLength(0);
  });

  it("counts 3-level chain correctly", async () => {
    const root = await createPassenger("chain-root@ptest.com");
    const l1 = await createPassenger("chain-l1@ptest.com");
    const l2 = await createPassenger("chain-l2@ptest.com");
    const l3 = await createPassenger("chain-l3@ptest.com");

    await createPassengerReferral(l1.id, root.id);
    await createPassengerReferral(l2.id, l1.id);
    await createPassengerReferral(l3.id, l2.id);

    const network = await getPassengerNetwork(root.id);

    expect(network.level1).toEqual([l1.id]);
    expect(network.level2).toEqual([l2.id]);
    expect(network.level3).toEqual([l3.id]);
  });
});

// ─── assignPassengerIdentity ──────────────────────────────────────────────────

describe("assignPassengerIdentity", () => {
  it("sets referralCode matching pattern slug-4chars", async () => {
    const p = await createPassenger("identity-a@ptest.com");
    await assignPassengerIdentity(p.id, "Maria Silva");
    const updated = await prisma.passenger.findUniqueOrThrow({ where: { id: p.id } });
    expect(updated.referralCode).toMatch(/^[a-z0-9-]+-[a-z0-9]{4}$/);
  });

  it("sets publicSlug as a URL-safe normalized slug (base slug only)", async () => {
    const p = await createPassenger("identity-b@ptest.com");
    await assignPassengerIdentity(p.id, "João da Silva");
    const updated = await prisma.passenger.findUniqueOrThrow({ where: { id: p.id } });
    expect(updated.publicSlug).toMatch(/^joao-da-silva/);
  });

  it("two passengers with same name get different referralCodes", async () => {
    const a = await createPassenger("same-name-a@ptest.com");
    const b = await createPassenger("same-name-b@ptest.com");
    await assignPassengerIdentity(a.id, "Same Name");
    await assignPassengerIdentity(b.id, "Same Name");
    const ra = await prisma.passenger.findUniqueOrThrow({ where: { id: a.id } });
    const rb = await prisma.passenger.findUniqueOrThrow({ where: { id: b.id } });
    expect(ra.referralCode).not.toBe(rb.referralCode);
  });

  it("is idempotent — calling twice keeps same codes", async () => {
    const p = await createPassenger("idempotent@ptest.com");
    const { referralCode, publicSlug } = await assignPassengerIdentity(p.id, "Idempotent User");
    const again = await assignPassengerIdentity(p.id, "Idempotent User");
    expect(again.referralCode).toBe(referralCode);
    expect(again.publicSlug).toBe(publicSlug);
  });
});
