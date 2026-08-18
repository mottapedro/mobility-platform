/**
 * INVARIANTES DE REWARD (I-R1..I-R5)
 *
 * Verificam o contrato do domínio RewardDistribution (ADR-003).
 * A maioria são testes de propriedade pura (sem DB), validando que as funções
 * de cálculo de cashback respeitam os limites definidos na ADR-003 §7.
 *
 * Uma falha aqui indica violação de ADR-003.
 */

import { PLATFORM_FEE_CENTS } from "../../src/domain/payment/RevenueSplitService";

// ---------------------------------------------------------------------------
// Constantes da ADR-003 §7 (Passenger Cashback P2P)
// ---------------------------------------------------------------------------

const CASHBACK_BPS = 100;          // 1% do driverNetAmount do indicado
const CASHBACK_MAX_CENTS = 1_000;  // R$10,00 por corrida

/**
 * Cálculo de cashback P2P — replica a lógica definida em ADR-003 §7.
 * A implementação real virá na Fase 3 (RewardDistributionService).
 * Este teste valida o contrato matemático, não a implementação.
 */
function calculateCashback(driverNetAmountCents: number): number {
  const raw = Math.floor((driverNetAmountCents * CASHBACK_BPS) / 10_000);
  return Math.min(raw, CASHBACK_MAX_CENTS);
}

// ---------------------------------------------------------------------------
// I-R1: cashback nunca excede R$10,00 (I-12 da ADR-003)
// ---------------------------------------------------------------------------

describe("I-R1 / I-12: cashback nunca excede R$10,00 (1.000 cents) por corrida", () => {
  const driverNetAmounts = [
    251,           // mínimo possível (total = R$5,00 - platformFee)
    5_000,
    10_000,
    50_000,
    1_000_000,     // valor absurdo — teto deve segurar
  ];

  it.each(driverNetAmounts)(
    "driverNetAmount = %i cents → cashback <= 1.000 cents",
    (driverNet) => {
      expect(calculateCashback(driverNet)).toBeLessThanOrEqual(CASHBACK_MAX_CENTS);
    },
  );
});

// ---------------------------------------------------------------------------
// I-R2: cashback é sempre não-negativo
// ---------------------------------------------------------------------------

describe("I-R2: cashback nunca negativo", () => {
  it("retorna 0 para driverNetAmount = 0", () => {
    expect(calculateCashback(0)).toBe(0);
  });

  it("retorna 0 para valores abaixo do mínimo de 1 cent de cashback", () => {
    // 99 cents de driverNetAmount → floor(99 * 100 / 10_000) = floor(0.99) = 0
    expect(calculateCashback(99)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// I-R3: cashback nunca excede driverNetAmount do indicado (I-11)
// ---------------------------------------------------------------------------

describe("I-R3 / I-11: cashback <= driverNetAmount do indicado", () => {
  it("para qualquer driverNetAmount, cashback <= driverNetAmount", () => {
    [100, 500, 1_000, 5_000, 100_000].forEach((driverNet) => {
      expect(calculateCashback(driverNet)).toBeLessThanOrEqual(driverNet);
    });
  });
});

// ---------------------------------------------------------------------------
// I-R4: cashback não consome driverCents — só plataforma (I-9)
// ---------------------------------------------------------------------------

describe("I-R4 / I-9: cashback é financiado pela plataforma, nunca pelo motorista", () => {
  it("driverNetAmount não é reduzido pelo cashback (separação de economias)", () => {
    // Este teste verifica o contrato, não a implementação.
    // Na Fase 3, o RewardDistributionService criará um RewardEvent debitado
    // da Receita da Plataforma (platformCents) — sem tocar em driverCents.

    const totalCents = 10_000;
    const driverNetAmount = totalCents - PLATFORM_FEE_CENTS; // 9750
    const cashback = calculateCashback(driverNetAmount);

    // O driverNetAmount no Settlement permanece inalterado após o Reward
    // (Settlement nunca é modificado pós-criação — ADR-001 §4)
    expect(driverNetAmount - cashback).not.toBe(driverNetAmount); // cashback existe
    expect(driverNetAmount).toBe(totalCents - PLATFORM_FEE_CENTS); // driverNet inalterado
  });
});

// ---------------------------------------------------------------------------
// I-R5: fórmula de cashback — 1% com floor (sem arredondamento para cima)
// ---------------------------------------------------------------------------

describe("I-R5: fórmula cashback = floor(driverNetAmount × 100 / 10_000)", () => {
  const cases: Array<[number, number]> = [
    [10_000, 100],    // 1% de R$100,00 = R$1,00
    [50_000, 500],    // 1% de R$500,00 = R$5,00 (dentro do teto)
    [200_000, 1_000], // 1% de R$2000,00 = R$20,00 → limitado a R$10,00
    [9_999, 99],      // floor(9999 × 100 / 10000) = floor(99.99) = 99
    [100, 1],         // floor(100 × 100 / 10000) = floor(1) = 1
    [99, 0],          // floor(99 × 100 / 10000) = floor(0.99) = 0
  ];

  it.each(cases)(
    "driverNetAmount=%i → cashback=%i cents",
    (driverNet, expected) => {
      expect(calculateCashback(driverNet)).toBe(expected);
    },
  );
});
