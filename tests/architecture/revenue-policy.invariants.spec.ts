/**
 * INVARIANTES DE REVENUE POLICY (I-RP1..I-RP6)
 *
 * Verificam o contrato da entidade RevenuePolicy e do RevenuePolicyRepository.
 * Estes testes têm acesso ao banco (precisam do prisma) para validar
 * invariantes de unicidade e resolução temporal.
 *
 * Uma falha aqui indica violação de ADR-002 §5.
 */

import { prisma } from "../setup";
import { RevenuePolicyRepository } from "../../src/domain/payment/RevenuePolicyRepository";

// ---------------------------------------------------------------------------
// Cleanup — remove políticas de teste criadas nesta suite
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await prisma.revenuePolicy.deleteMany({
    where: { code: { startsWith: "TEST_POLICY_" } },
  });
});

afterAll(async () => {
  await prisma.revenuePolicy.deleteMany({
    where: { code: { startsWith: "TEST_POLICY_" } },
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cria uma política temporária com code único por teste. */
async function createPolicy(
  suffix: string,
  overrides: {
    rootDriverBps?: number;
    isActive?: boolean;
    effectiveFrom?: Date | null;
    effectiveUntil?: Date | null;
    version?: number;
  } = {},
) {
  return prisma.revenuePolicy.create({
    data: {
      code: `TEST_POLICY_${suffix}`,
      name: `Test Policy ${suffix}`,
      version: overrides.version ?? 1,
      baseType: "OPERATIONAL_REVENUE",
      rootDriverBps: overrides.rootDriverBps ?? 500,
      isActive: overrides.isActive ?? true,
      effectiveFrom: overrides.effectiveFrom !== undefined ? overrides.effectiveFrom : null,
      effectiveUntil: overrides.effectiveUntil !== undefined ? overrides.effectiveUntil : null,
    },
  });
}

const repo = new RevenuePolicyRepository(prisma);

// ---------------------------------------------------------------------------
// I-RP1: política ativa é resolvida corretamente
// ---------------------------------------------------------------------------

describe("I-RP1: findActivePolicy — resolve política ativa dentro da vigência", () => {
  it("retorna política ativa sem datas de vigência (sempre vigente)", async () => {
    const policy = await createPolicy("RP1_ALWAYS");
    const found = await repo.findActivePolicy(`TEST_POLICY_RP1_ALWAYS`);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(policy.id);
  });

  it("retorna política ativa dentro de effectiveFrom/effectiveUntil", async () => {
    const past = new Date(Date.now() - 7 * 86_400_000);
    const future = new Date(Date.now() + 7 * 86_400_000);
    await createPolicy("RP1_RANGED", { effectiveFrom: past, effectiveUntil: future });
    const found = await repo.findActivePolicy("TEST_POLICY_RP1_RANGED");
    expect(found).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// I-RP2: política fora da vigência não pode ser resolvida
// ---------------------------------------------------------------------------

describe("I-RP2: políticas expiradas ou fora de vigência são rejeitadas", () => {
  it("retorna null quando effectiveUntil está no passado", async () => {
    const past1 = new Date(Date.now() - 14 * 86_400_000);
    const past2 = new Date(Date.now() - 7 * 86_400_000);
    await createPolicy("RP2_EXPIRED", { effectiveFrom: past1, effectiveUntil: past2 });
    const found = await repo.findActivePolicy("TEST_POLICY_RP2_EXPIRED");
    expect(found).toBeNull();
  });

  it("retorna null quando effectiveFrom está no futuro", async () => {
    const future = new Date(Date.now() + 30 * 86_400_000);
    await createPolicy("RP2_FUTURE", { effectiveFrom: future });
    const found = await repo.findActivePolicy("TEST_POLICY_RP2_FUTURE");
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// I-RP3: política inativa nunca é resolvida
// ---------------------------------------------------------------------------

describe("I-RP3: políticas com isActive = false nunca são resolvidas", () => {
  it("retorna null para política inativa mesmo sem restrição de vigência", async () => {
    await createPolicy("RP3_INACTIVE", { isActive: false });
    const found = await repo.findActivePolicy("TEST_POLICY_RP3_INACTIVE");
    expect(found).toBeNull();
  });

  it("retorna null para política inativa mesmo dentro da vigência", async () => {
    const past = new Date(Date.now() - 7 * 86_400_000);
    const future = new Date(Date.now() + 7 * 86_400_000);
    await createPolicy("RP3_INACTIVE_RANGED", {
      isActive: false,
      effectiveFrom: past,
      effectiveUntil: future,
    });
    const found = await repo.findActivePolicy("TEST_POLICY_RP3_INACTIVE_RANGED");
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// I-RP4: quando múltiplas versões existem, a versão mais recente (maior version) é retornada
// ---------------------------------------------------------------------------

describe("I-RP4: múltiplas versões — versão mais recente prevalece", () => {
  it("retorna a versão com maior `version` entre políticas ativas do mesmo code", async () => {
    // Cria v1 e v2 com mesmo code (unique key é code+version)
    const code = "TEST_POLICY_RP4_MULTI";
    await prisma.revenuePolicy.create({
      data: { code, name: "v1", version: 1, baseType: "OPERATIONAL_REVENUE", rootDriverBps: 300, isActive: true },
    });
    await prisma.revenuePolicy.create({
      data: { code, name: "v2", version: 2, baseType: "OPERATIONAL_REVENUE", rootDriverBps: 500, isActive: true },
    });

    const found = await repo.findActivePolicy(code);
    expect(found).not.toBeNull();
    expect(found!.version).toBe(2);
    expect(found!.rootDriverBps).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// I-RP5: code é imutável — unique constraint impede duplicata
// ---------------------------------------------------------------------------

describe("I-RP5: unicidade de (code, version) — constraint do banco", () => {
  it("lança ao tentar criar dois registros com mesmo (code, version)", async () => {
    const code = "TEST_POLICY_RP5_UNIQUE";
    await prisma.revenuePolicy.create({
      data: { code, name: "first", version: 1, baseType: "OPERATIONAL_REVENUE", rootDriverBps: 500, isActive: true },
    });
    await expect(
      prisma.revenuePolicy.create({
        data: { code, name: "duplicate", version: 1, baseType: "OPERATIONAL_REVENUE", rootDriverBps: 700, isActive: true },
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// I-RP6: resolveForRide retorna null quando nenhuma política está vigente
// ---------------------------------------------------------------------------

describe("I-RP6: resolveForRide retorna null → VG-2 bloqueará Settlement", () => {
  it("retorna null para code inexistente", async () => {
    const found = await repo.resolveForRide(new Date(), "NON_EXISTENT_POLICY");
    expect(found).toBeNull();
  });
});
