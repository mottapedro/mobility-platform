import { RevenuePolicy } from "@prisma/client";
import { PLATFORM_FEE_CENTS } from "./RevenueSplitService";

/**
 * ADR-002 v1.1 — Validation Gate
 *
 * Pré-condição obrigatória antes de criar qualquer Settlement.
 * Função pura: sem efeitos colaterais, sem acesso ao banco.
 * Retorna lista de violações (vazia = contexto válido).
 */

export interface PricingSnapshotContext {
  /** totalPassengerPrice em centavos */
  totalCents: number;
  /** driverNetAmount em centavos (baseFare + liquidityAmount) */
  driverNetAmountCents: number;
  /** platformFee em centavos — deve ser PLATFORM_FEE_CENTS */
  platformFeeCents: number;
  /** true quando todos os campos do Pricing Snapshot estão presentes */
  isComplete: boolean;
}

export interface SettlementComputedValues {
  platformCents: number;
  driverCents: number;
  rootDriverCents: number;
  rootDriverId: string | null;
}

export interface GateViolation {
  code: string;
  message: string;
}

/**
 * Valida o contexto completo antes da criação do Settlement.
 *
 * @param snapshot - Valores do Pricing Snapshot da corrida
 * @param policy   - RevenuePolicy ativa (null = nenhuma política aplicável)
 * @param computed - Valores calculados pelo RevenueSplitService V2
 * @returns Lista de violações. Vazia = contexto válido para criar Settlement.
 */
export function validateSettlementContext(
  snapshot: PricingSnapshotContext,
  policy: RevenuePolicy | null,
  computed: SettlementComputedValues,
): GateViolation[] {
  const violations: GateViolation[] = [];

  // VG-1: PricingSnapshot completo
  if (!snapshot.isComplete) {
    violations.push({
      code: "MissingPricingSnapshot",
      message:
        "PricingSnapshot inválido: um ou mais campos obrigatórios estão ausentes (baseCOE, zoneMultiplier, liquidityMargin, liquidityAmount, driverNetAmount, platformFee, totalPassengerPrice).",
    });
  }

  // VG-2: RevenuePolicy ativa e aplicável
  if (policy === null) {
    violations.push({
      code: "NoPolicyApplicable",
      message:
        "Nenhuma RevenuePolicy ativa encontrada para a data da corrida. O Settlement não pode ser criado sem uma política de distribuição vigente.",
    });
  }

  // VG-3: Consistência do driverNetAmount
  const expectedDriverNet = snapshot.totalCents - snapshot.platformFeeCents;
  if (snapshot.driverNetAmountCents !== expectedDriverNet) {
    violations.push({
      code: "SnapshotInconsistent",
      message:
        `driverNetAmount inconsistente: esperado ${expectedDriverNet} cents ` +
        `(totalCents ${snapshot.totalCents} − platformFee ${snapshot.platformFeeCents}), ` +
        `encontrado ${snapshot.driverNetAmountCents} cents.`,
    });
  }

  // VG-4: Soma dos splits = totalCents (invariante I-4)
  const splitSum =
    computed.platformCents + computed.driverCents + computed.rootDriverCents;
  if (splitSum !== snapshot.totalCents) {
    violations.push({
      code: "SumInvariantViolated",
      message:
        `Invariante I-4 violado: platformCents (${computed.platformCents}) + ` +
        `driverCents (${computed.driverCents}) + rootDriverCents (${computed.rootDriverCents}) ` +
        `= ${splitSum}, mas totalCents = ${snapshot.totalCents}.`,
    });
  }

  // VG-5: rootDriverCents <= driverNetAmount (invariante I-6)
  if (computed.rootDriverCents > snapshot.driverNetAmountCents) {
    violations.push({
      code: "RootDriverExceedsOperational",
      message:
        `Invariante I-6 violado: rootDriverCents (${computed.rootDriverCents}) ` +
        `excede driverNetAmount (${snapshot.driverNetAmountCents} cents).`,
    });
  }

  // VG-6: rootDriverId presente → policy deve ter rootDriverBps > 0
  if (
    computed.rootDriverId !== null &&
    policy !== null &&
    policy.rootDriverBps <= 0
  ) {
    violations.push({
      code: "PolicyMismatch",
      message:
        `rootDriverId está presente (${computed.rootDriverId}), ` +
        `mas a política ${policy.code} v${policy.version} define rootDriverBps = ${policy.rootDriverBps} (inativo).`,
    });
  }

  return violations;
}

/**
 * Versão assertiva do gate: lança erro descritivo se qualquer violação for encontrada.
 * Use no SettlementService antes da transação de escrita.
 */
export function assertSettlementContext(
  snapshot: PricingSnapshotContext,
  policy: RevenuePolicy | null,
  computed: SettlementComputedValues,
): void {
  const violations = validateSettlementContext(snapshot, policy, computed);
  if (violations.length === 0) return;

  const detail = violations
    .map((v) => `  [${v.code}] ${v.message}`)
    .join("\n");

  throw new Error(
    `Settlement bloqueado pelo Validation Gate (${violations.length} violação(ões)):\n${detail}`,
  );
}
