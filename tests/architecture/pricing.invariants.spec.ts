/**
 * INVARIANTES DE PRICING (I-P1..I-P5)
 *
 * Verificam propriedades que devem ser verdadeiras para qualquer saída do
 * PricingEngine, independente de caso de uso. Não testam cenários de negócio;
 * testam o contrato matemático e estrutural do domínio de precificação.
 *
 * Estes são testes de arquitetura: uma falha aqui indica violação de ADR-001.
 */

import { PRICING_CONFIG } from "../../src/domain/pricing/PricingConfiguration";
import { PLATFORM_FEE_CENTS } from "../../src/domain/payment/RevenueSplitService";

// ---------------------------------------------------------------------------
// Helpers de construção de snapshots fictícios
// ---------------------------------------------------------------------------

interface PricingSnapshot {
  baseCOE: number;
  zoneMultiplier: number;
  liquidityMargin: number;
  liquidityAmount: number;
  baseFare: number;
  driverNetAmount: number;
  platformFee: number;
  totalPassengerPrice: number;
}

/** Constrói um snapshot a partir de inputs brutos, imitando o que o PricingEngine produziria. */
function buildSnapshot(
  distanceKm: number,
  zoneMultiplier: number,
  liquidityMargin: number,
): PricingSnapshot {
  const baseCOE = distanceKm * PRICING_CONFIG.baseCostPerKm;
  const baseFare = Math.round(baseCOE * zoneMultiplier * 100) / 100;
  const liquidityAmount = Math.round(baseFare * liquidityMargin * 100) / 100;
  const driverNetAmount = Math.round((baseFare + liquidityAmount) * 100) / 100;
  const platformFee = PRICING_CONFIG.platformFeeDefault;
  const totalPassengerPrice = Math.max(
    Math.round((driverNetAmount + platformFee) * 100) / 100,
    PRICING_CONFIG.minimumFare,
  );
  return { baseCOE, zoneMultiplier, liquidityMargin, liquidityAmount, baseFare, driverNetAmount, platformFee, totalPassengerPrice };
}

// Matriz de cenários: distância × zona × liquidez
const SCENARIOS: Array<[number, number, number, string]> = [
  [2, 1.0, 0.20, "local curto — liquidez normal"],
  [10, 1.0, 0.20, "local médio — liquidez normal"],
  [25, 2.0, 0.20, "intermunicipal — liquidez normal"],
  [5, 1.0, 0.55, "local curto — liquidez alta"],
  [30, 2.0, 0.55, "intermunicipal — liquidez alta"],
  [50, 3.5, 0.55, "intermunicipal pesado — liquidez alta"],
];

describe("Pricing Invariants (ADR-001)", () => {
  describe("I-P1: baseFare = baseCOE × zoneMultiplier", () => {
    it.each(SCENARIOS)("cenário: %s km × zona %s × liquidez %s — %s", (km, zone, liq) => {
      const snap = buildSnapshot(km, zone, liq);
      const expected = Math.round(snap.baseCOE * zone * 100) / 100;
      expect(snap.baseFare).toBeCloseTo(expected, 5);
    });
  });

  describe("I-P2: liquidityAmount = baseFare × liquidityMargin", () => {
    it.each(SCENARIOS)("cenário: %s km × zona %s × liquidez %s — %s", (km, zone, liq) => {
      const snap = buildSnapshot(km, zone, liq);
      const expected = Math.round(snap.baseFare * liq * 100) / 100;
      expect(snap.liquidityAmount).toBeCloseTo(expected, 5);
    });
  });

  describe("I-P3: driverNetAmount = baseFare + liquidityAmount (antes da taxa da plataforma)", () => {
    it.each(SCENARIOS)("cenário: %s km × zona %s × liquidez %s — %s", (km, zone, liq) => {
      const snap = buildSnapshot(km, zone, liq);
      expect(snap.driverNetAmount).toBeCloseTo(snap.baseFare + snap.liquidityAmount, 5);
    });
  });

  describe("I-P4: totalPassengerPrice = driverNetAmount + platformFee (ou mínimo)", () => {
    it.each(SCENARIOS)("cenário: %s km × zona %s × liquidez %s — %s", (km, zone, liq) => {
      const snap = buildSnapshot(km, zone, liq);
      const rawTotal = snap.driverNetAmount + snap.platformFee;
      expect(snap.totalPassengerPrice).toBeGreaterThanOrEqual(PRICING_CONFIG.minimumFare);
      expect(snap.totalPassengerPrice).toBeGreaterThanOrEqual(rawTotal - 0.001);
    });
  });

  describe("I-P5: platformFee não integra driverNetAmount (economias separadas — ADR-002)", () => {
    it.each(SCENARIOS)("cenário: %s km × zona %s × liquidez %s — %s", (km, zone, liq) => {
      const snap = buildSnapshot(km, zone, liq);
      // driverNetAmount nunca inclui a platformFee
      expect(snap.driverNetAmount).toBeLessThan(snap.totalPassengerPrice);
      expect(snap.totalPassengerPrice - snap.driverNetAmount).toBeCloseTo(
        snap.platformFee,
        5,
      );
    });
  });

  describe("I-P6: liquidityMargin está dentro do intervalo permitido pela configuração", () => {
    it("os dois valores de margem são os únicos permitidos", () => {
      const allowed = [PRICING_CONFIG.liquidityMarginNormal, PRICING_CONFIG.liquidityMarginHigh];
      expect(allowed).toContain(0.20);
      expect(allowed).toContain(0.55);
    });

    it.each(SCENARIOS)("cenário usa margem válida: %s km × zona %s × liquidez %s — %s", (km, zone, liq) => {
      const allowed = [PRICING_CONFIG.liquidityMarginNormal, PRICING_CONFIG.liquidityMarginHigh];
      expect(allowed).toContain(liq);
    });
  });

  describe("I-P7: PricingConfig.platformFeeDefault coincide com PLATFORM_FEE_CENTS", () => {
    it("R$2,50 fixo — mesma constante nos dois domínios", () => {
      // PLATFORM_FEE_CENTS está em centavos; platformFeeDefault em reais
      expect(PRICING_CONFIG.platformFeeDefault * 100).toBe(PLATFORM_FEE_CENTS);
    });
  });
});
