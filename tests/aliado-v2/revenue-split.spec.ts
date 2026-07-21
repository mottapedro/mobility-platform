/**
 * RevenueSplitService — unit tests
 *
 * Cobre V1 (computeRevenueSplit) e V2 (computeRevenueSplitV2).
 * Sem acesso ao banco — testes puramente unitários.
 */
import {
  computeRevenueSplit,
  computeRevenueSplitV2,
  PLATFORM_FEE_CENTS,
} from "../../src/domain/payment/RevenueSplitService";
import { RevenuePolicy } from "@prisma/client";

// Política stub reutilizada nos testes V2
function makePolicy(rootDriverBps: number): RevenuePolicy {
  return {
    id: "policy-test-id",
    code: "ROOT_DRIVER_STANDARD",
    name: "Padrão",
    version: 1,
    baseType: "OPERATIONAL_REVENUE",
    rootDriverBps,
    effectiveFrom: null,
    effectiveUntil: null,
    isActive: true,
    createdAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// V1 — taxa fixa R$2,50 (ADR-001 §3)
// ---------------------------------------------------------------------------

describe("computeRevenueSplit (V1 — taxa fixa)", () => {
  it("platform = R$2,50 fixo; driver = total - platform; root = 0", () => {
    const r = computeRevenueSplit({ totalCents: 10_000, rootDriverId: "root-1" });
    expect(r.platformCents).toBe(PLATFORM_FEE_CENTS); // 250
    expect(r.driverCents).toBe(10_000 - PLATFORM_FEE_CENTS); // 9750
    expect(r.rootDriverCents).toBe(0);
    expect(r.rootDriverId).toBe("root-1");
    expect(r.policyId).toBeNull();
  });

  it("root = 0 quando rootDriverId = null (I-6 V1)", () => {
    const r = computeRevenueSplit({ totalCents: 10_000, rootDriverId: null });
    expect(r.rootDriverCents).toBe(0);
    expect(r.driverCents).toBe(10_000 - PLATFORM_FEE_CENTS);
    expect(r.rootDriverId).toBeNull();
  });

  it("soma invariante I-4: platform + driver + root = total", () => {
    for (const total of [500, 1000, 3333, 10_000, 99_999]) {
      const r = computeRevenueSplit({ totalCents: total, rootDriverId: null });
      expect(r.platformCents + r.driverCents + r.rootDriverCents).toBe(total);
    }
  });

  it("rejeita totalCents <= platformFee", () => {
    expect(() =>
      computeRevenueSplit({ totalCents: PLATFORM_FEE_CENTS, rootDriverId: null }),
    ).toThrow();
  });

  it("rejeita totalCents <= 0", () => {
    expect(() => computeRevenueSplit({ totalCents: 0, rootDriverId: null })).toThrow();
    expect(() => computeRevenueSplit({ totalCents: -1, rootDriverId: null })).toThrow();
  });

  it("rejeita totalCents não-inteiro", () => {
    expect(() =>
      computeRevenueSplit({ totalCents: 100.5, rootDriverId: null }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// V2 — com RevenuePolicy (ADR-002 §6)
// ---------------------------------------------------------------------------

describe("computeRevenueSplitV2 (com RevenuePolicy)", () => {
  it("rootDriverCents = floor(driverNetAmount × bps / 10_000)", () => {
    const policy = makePolicy(500); // 5%
    const r = computeRevenueSplitV2({ totalCents: 10_000, rootDriverId: "root-1", policy });
    const driverNet = 10_000 - PLATFORM_FEE_CENTS; // 9750
    const expectedRoot = Math.floor((driverNet * 500) / 10_000); // 487
    expect(r.rootDriverCents).toBe(expectedRoot);
    expect(r.driverCents).toBe(driverNet - expectedRoot);
    expect(r.platformCents).toBe(PLATFORM_FEE_CENTS);
  });

  it("soma invariante I-4: platform + driver + root = total", () => {
    const policy = makePolicy(500);
    for (const total of [500, 1000, 3333, 10_000, 99_999]) {
      const r = computeRevenueSplitV2({ totalCents: total, rootDriverId: "root-x", policy });
      expect(r.platformCents + r.driverCents + r.rootDriverCents).toBe(total);
    }
  });

  it("rootDriverCents = 0 quando rootDriverId = null (I-6)", () => {
    const policy = makePolicy(500);
    const r = computeRevenueSplitV2({ totalCents: 10_000, rootDriverId: null, policy });
    expect(r.rootDriverCents).toBe(0);
    expect(r.driverCents).toBe(10_000 - PLATFORM_FEE_CENTS);
  });

  it("rootDriverCents = 0 quando policy.rootDriverBps = 0", () => {
    const policy = makePolicy(0);
    const r = computeRevenueSplitV2({ totalCents: 10_000, rootDriverId: "root-1", policy });
    expect(r.rootDriverCents).toBe(0);
    expect(r.driverCents).toBe(10_000 - PLATFORM_FEE_CENTS);
  });

  it("rootDriverCents nunca excede driverNetAmount (I-6) — bps 9999", () => {
    // Mesmo com bps altíssimo, root nunca > driverNetAmount
    const policy = makePolicy(9999);
    const r = computeRevenueSplitV2({ totalCents: 10_000, rootDriverId: "root-1", policy });
    const driverNet = 10_000 - PLATFORM_FEE_CENTS;
    expect(r.rootDriverCents).toBeLessThanOrEqual(driverNet);
    expect(r.driverCents).toBeGreaterThanOrEqual(0);
  });

  it("persiste policyId, policyCode e policyVersion no resultado", () => {
    const policy = makePolicy(500);
    const r = computeRevenueSplitV2({ totalCents: 10_000, rootDriverId: "root-1", policy });
    expect(r.policyId).toBe(policy.id);
    expect(r.policyCode).toBe(policy.code);
    expect(r.policyVersion).toBe(policy.version);
  });
});
