/**
 * INVARIANTES DE SETTLEMENT (I-1..I-8)
 *
 * Verificam o contrato econômico do Settlement V2 (ADR-001 + ADR-002 v1.1).
 * Testes puros (sem DB) sobre as funções do domínio de pagamento.
 *
 * Uma falha aqui indica violação de ADR-001 §4 ou ADR-002 §§6+9.
 */

import { RevenuePolicy } from "@prisma/client";
import {
  computeRevenueSplit,
  computeRevenueSplitV2,
  PLATFORM_FEE_CENTS,
} from "../../src/domain/payment/RevenueSplitService";
import {
  validateSettlementContext,
  assertSettlementContext,
  type PricingSnapshotContext,
  type SettlementComputedValues,
} from "../../src/domain/payment/ValidationGate";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePolicy(bps: number, overrides: Partial<RevenuePolicy> = {}): RevenuePolicy {
  return {
    id: "policy-id",
    code: "ROOT_DRIVER_STANDARD",
    name: "Padrão",
    version: 1,
    baseType: "OPERATIONAL_REVENUE",
    rootDriverBps: bps,
    effectiveFrom: null,
    effectiveUntil: null,
    isActive: true,
    createdAt: new Date(),
    ...overrides,
  };
}

function completeSnapshot(totalCents: number): PricingSnapshotContext {
  const driverNetAmountCents = totalCents - PLATFORM_FEE_CENTS;
  return {
    totalCents,
    driverNetAmountCents,
    platformFeeCents: PLATFORM_FEE_CENTS,
    isComplete: true,
  };
}

// ---------------------------------------------------------------------------
// I-1..I-3: nenhum valor negativo
// ---------------------------------------------------------------------------

describe("I-1..I-3: splits nunca negativos", () => {
  const totals = [300, 1_000, 10_000, 99_999];

  it("I-1: platformCents >= 0 para qualquer total", () => {
    totals.forEach((t) => {
      const r = computeRevenueSplit({ totalCents: t, rootDriverId: null });
      expect(r.platformCents).toBeGreaterThanOrEqual(0);
    });
  });

  it("I-2: driverCents >= 0 para qualquer total (V1)", () => {
    totals.forEach((t) => {
      const r = computeRevenueSplit({ totalCents: t, rootDriverId: null });
      expect(r.driverCents).toBeGreaterThanOrEqual(0);
    });
  });

  it("I-2: driverCents >= 0 para qualquer total (V2 com policy 5%)", () => {
    const policy = makePolicy(500);
    totals.forEach((t) => {
      const r = computeRevenueSplitV2({ totalCents: t, rootDriverId: "root-x", policy });
      expect(r.driverCents).toBeGreaterThanOrEqual(0);
    });
  });

  it("I-3: rootDriverCents >= 0 para qualquer total e bps", () => {
    [0, 100, 500, 1000, 9999].forEach((bps) => {
      const policy = makePolicy(bps);
      totals.forEach((t) => {
        const r = computeRevenueSplitV2({ totalCents: t, rootDriverId: "root-x", policy });
        expect(r.rootDriverCents).toBeGreaterThanOrEqual(0);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// I-4: soma invariante
// ---------------------------------------------------------------------------

describe("I-4: platform + driver + root = total (nenhum centavo perdido ou duplicado)", () => {
  it("V1 — sem rootDriver", () => {
    [300, 1_000, 3_333, 10_000, 99_999].forEach((t) => {
      const r = computeRevenueSplit({ totalCents: t, rootDriverId: null });
      expect(r.platformCents + r.driverCents + r.rootDriverCents).toBe(t);
    });
  });

  it("V2 — com rootDriver (5%)", () => {
    const policy = makePolicy(500);
    [300, 1_000, 3_333, 10_000, 99_999].forEach((t) => {
      const r = computeRevenueSplitV2({ totalCents: t, rootDriverId: "root-x", policy });
      expect(r.platformCents + r.driverCents + r.rootDriverCents).toBe(t);
    });
  });

  it("V2 — com rootDriver em bps extremos (0 e 9999)", () => {
    [0, 9999].forEach((bps) => {
      const policy = makePolicy(bps);
      [1_000, 10_000].forEach((t) => {
        const r = computeRevenueSplitV2({ totalCents: t, rootDriverId: "root-x", policy });
        expect(r.platformCents + r.driverCents + r.rootDriverCents).toBe(t);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// I-5: platformCents = PLATFORM_FEE_CENTS (sempre fixo — ADR-001 §3)
// ---------------------------------------------------------------------------

describe("I-5: platformCents = PLATFORM_FEE_CENTS sempre", () => {
  it("V1", () => {
    [300, 5_000, 10_000].forEach((t) => {
      const r = computeRevenueSplit({ totalCents: t, rootDriverId: null });
      expect(r.platformCents).toBe(PLATFORM_FEE_CENTS);
    });
  });

  it("V2", () => {
    const policy = makePolicy(500);
    [300, 5_000, 10_000].forEach((t) => {
      const r = computeRevenueSplitV2({ totalCents: t, rootDriverId: "root-x", policy });
      expect(r.platformCents).toBe(PLATFORM_FEE_CENTS);
    });
  });
});

// ---------------------------------------------------------------------------
// I-6: rootDriverCents <= driverNetAmount
// ---------------------------------------------------------------------------

describe("I-6: rootDriverCents <= driverNetAmount", () => {
  it("nunca ultrapassa driverNetAmount mesmo com bps = 9999", () => {
    const policy = makePolicy(9999);
    [300, 1_000, 10_000].forEach((t) => {
      const r = computeRevenueSplitV2({ totalCents: t, rootDriverId: "root-x", policy });
      const driverNet = t - PLATFORM_FEE_CENTS;
      expect(r.rootDriverCents).toBeLessThanOrEqual(driverNet);
    });
  });

  it("= 0 quando rootDriverId = null (I-6 corolário)", () => {
    const policy = makePolicy(500);
    const r = computeRevenueSplitV2({ totalCents: 10_000, rootDriverId: null, policy });
    expect(r.rootDriverCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// I-7: Settlement nunca recalcula preço — Validation Gate detecta inconsistência
// ---------------------------------------------------------------------------

describe("I-7: Settlement não recalcula — Validation Gate detecta snapshot inconsistente", () => {
  it("VG-3 dispara quando driverNetAmount != total - platformFee", () => {
    const totalCents = 10_000;
    const snapshot: PricingSnapshotContext = {
      totalCents,
      driverNetAmountCents: 9_000, // errado: deveria ser 9_750
      platformFeeCents: PLATFORM_FEE_CENTS,
      isComplete: true,
    };
    const policy = makePolicy(500);
    const split = computeRevenueSplitV2({ totalCents, rootDriverId: null, policy });
    const computed: SettlementComputedValues = {
      platformCents: split.platformCents,
      driverCents: split.driverCents,
      rootDriverCents: split.rootDriverCents,
      rootDriverId: null,
    };
    const violations = validateSettlementContext(snapshot, policy, computed);
    expect(violations.some((v) => v.code === "SnapshotInconsistent")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I-8: Settlement não é criado sem PricingSnapshot (VG-1)
// ---------------------------------------------------------------------------

describe("I-8: Settlement bloqueado sem PricingSnapshot completo (VG-1)", () => {
  it("VG-1 dispara quando snapshot.isComplete = false", () => {
    const totalCents = 5_000;
    const snapshot: PricingSnapshotContext = {
      totalCents,
      driverNetAmountCents: totalCents - PLATFORM_FEE_CENTS,
      platformFeeCents: PLATFORM_FEE_CENTS,
      isComplete: false,
    };
    const policy = makePolicy(500);
    const split = computeRevenueSplitV2({ totalCents, rootDriverId: null, policy });
    const computed: SettlementComputedValues = {
      platformCents: split.platformCents,
      driverCents: split.driverCents,
      rootDriverCents: split.rootDriverCents,
      rootDriverId: null,
    };
    const violations = validateSettlementContext(snapshot, policy, computed);
    expect(violations.some((v) => v.code === "MissingPricingSnapshot")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation Gate — cobertura completa de todos os códigos de violação
// ---------------------------------------------------------------------------

describe("ValidationGate — todos os códigos VG-1..VG-6", () => {
  const total = 10_000;
  const driverNet = total - PLATFORM_FEE_CENTS;
  const policy = makePolicy(500);
  const root500bps = Math.floor((driverNet * 500) / 10_000);

  function goodComputed(rootDriverId: string | null = null): SettlementComputedValues {
    const split = computeRevenueSplitV2({ totalCents: total, rootDriverId, policy });
    return {
      platformCents: split.platformCents,
      driverCents: split.driverCents,
      rootDriverCents: split.rootDriverCents,
      rootDriverId,
    };
  }

  it("VG-1: MissingPricingSnapshot — isComplete = false", () => {
    const snap = { ...completeSnapshot(total), isComplete: false };
    const v = validateSettlementContext(snap, policy, goodComputed());
    expect(v.some((x) => x.code === "MissingPricingSnapshot")).toBe(true);
  });

  it("VG-2: NoPolicyApplicable — policy = null", () => {
    const v = validateSettlementContext(completeSnapshot(total), null, goodComputed());
    expect(v.some((x) => x.code === "NoPolicyApplicable")).toBe(true);
  });

  it("VG-3: SnapshotInconsistent — driverNetAmount incorreto", () => {
    const snap = { ...completeSnapshot(total), driverNetAmountCents: 1 };
    const v = validateSettlementContext(snap, policy, goodComputed());
    expect(v.some((x) => x.code === "SnapshotInconsistent")).toBe(true);
  });

  it("VG-4: SumInvariantViolated — splits não somam total", () => {
    const computed: SettlementComputedValues = {
      platformCents: PLATFORM_FEE_CENTS,
      driverCents: 1, // deliberadamente errado
      rootDriverCents: 0,
      rootDriverId: null,
    };
    const v = validateSettlementContext(completeSnapshot(total), policy, computed);
    expect(v.some((x) => x.code === "SumInvariantViolated")).toBe(true);
  });

  it("VG-5: RootDriverExceedsOperational — rootDriverCents > driverNetAmount", () => {
    const computed: SettlementComputedValues = {
      platformCents: PLATFORM_FEE_CENTS,
      driverCents: 0,
      rootDriverCents: driverNet + 1, // excede driverNetAmount
      rootDriverId: "root-x",
    };
    const v = validateSettlementContext(completeSnapshot(total), policy, computed);
    expect(v.some((x) => x.code === "RootDriverExceedsOperational")).toBe(true);
  });

  it("VG-6: PolicyMismatch — rootDriverId presente + policy bps = 0", () => {
    const zeroPolicy = makePolicy(0);
    const split = computeRevenueSplitV2({ totalCents: total, rootDriverId: "root-x", policy: zeroPolicy });
    const computed: SettlementComputedValues = {
      platformCents: split.platformCents,
      driverCents: split.driverCents,
      rootDriverCents: split.rootDriverCents,
      rootDriverId: "root-x",
    };
    const v = validateSettlementContext(completeSnapshot(total), zeroPolicy, computed);
    expect(v.some((x) => x.code === "PolicyMismatch")).toBe(true);
  });

  it("contexto válido não gera violações", () => {
    const computed = goodComputed();
    const v = validateSettlementContext(completeSnapshot(total), policy, computed);
    expect(v).toHaveLength(0);
  });

  it("assertSettlementContext lança com mensagem descritiva quando há violações", () => {
    const snap = { ...completeSnapshot(total), isComplete: false };
    expect(() => assertSettlementContext(snap, null, goodComputed())).toThrow(
      /Settlement bloqueado pelo Validation Gate/,
    );
  });
});
