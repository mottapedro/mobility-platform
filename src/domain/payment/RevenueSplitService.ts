/**
 * ADR-001 + ADR-002 v1.1 — Revenue Split Service
 *
 * V1 (MVP): taxa fixa R$2,50, rootDriverCents = 0.
 * V2 (Settlement V2): recebe RevenuePolicy e calcula rootDriverCents dinamicamente.
 *
 * Este serviço executa a política recebida como parâmetro.
 * Não conhece regras de negócio — é a camada de execução, não de decisão.
 */

import { RevenuePolicy } from "@prisma/client";

export const PLATFORM_FEE_CENTS = 250; // R$2,50 — Taxa Operacional Cyborg (ADR-001 §3)

// ---------------------------------------------------------------------------
// Tipos compartilhados
// ---------------------------------------------------------------------------

export interface RevenueSplitResult {
  totalCents: number;
  platformCents: number;
  driverNetAmountCents: number; // = totalCents - platformCents
  driverCents: number;          // = driverNetAmountCents - rootDriverCents
  rootDriverCents: number;
  rootDriverId: string | null;
  /** Política aplicada. Null no V1 (MVP sem Root Driver ativo). */
  policyCode: string | null;
  policyVersion: number | null;
  policyId: string | null;
}

// ---------------------------------------------------------------------------
// Input V1 (compatibilidade com código existente)
// ---------------------------------------------------------------------------

export interface ComputeRevenueSplitInput {
  totalCents: number;
  rootDriverId: string | null;
}

/**
 * V1: distribui com taxa fixa, rootDriverCents = 0.
 * Mantido para compatibilidade com código existente até Settlement V2 estar completo.
 */
export function computeRevenueSplit(
  input: ComputeRevenueSplitInput,
): RevenueSplitResult {
  const { totalCents, rootDriverId } = input;

  assertTotalCents(totalCents);

  const platformCents = PLATFORM_FEE_CENTS;
  const driverNetAmountCents = totalCents - platformCents;

  return {
    totalCents,
    platformCents,
    driverNetAmountCents,
    driverCents: driverNetAmountCents,
    rootDriverCents: 0,
    rootDriverId,
    policyCode: null,
    policyVersion: null,
    policyId: null,
  };
}

// ---------------------------------------------------------------------------
// Input V2 (Settlement V2 com RevenuePolicy)
// ---------------------------------------------------------------------------

export interface ComputeRevenueSplitV2Input {
  totalCents: number;
  rootDriverId: string | null;
  policy: RevenuePolicy;
}

/**
 * V2: distribui respeitando a RevenuePolicy vigente.
 *
 * Fórmula (ADR-002 §6):
 *   rootDriverCents = floor(driverNetAmount × policy.rootDriverBps / 10_000)
 *   driverCents     = driverNetAmount − rootDriverCents
 *   platformCents   = PLATFORM_FEE_CENTS (sempre fixo)
 *
 * Quando rootDriverId = null, rootDriverCents = 0 independente da política (I-6).
 */
export function computeRevenueSplitV2(
  input: ComputeRevenueSplitV2Input,
): RevenueSplitResult {
  const { totalCents, rootDriverId, policy } = input;

  assertTotalCents(totalCents);

  const platformCents = PLATFORM_FEE_CENTS;
  const driverNetAmountCents = totalCents - platformCents;

  const rootDriverCents =
    rootDriverId !== null
      ? Math.floor((driverNetAmountCents * policy.rootDriverBps) / 10_000)
      : 0;

  const driverCents = driverNetAmountCents - rootDriverCents;

  return {
    totalCents,
    platformCents,
    driverNetAmountCents,
    driverCents,
    rootDriverCents,
    rootDriverId,
    policyCode: policy.code,
    policyVersion: policy.version,
    policyId: policy.id,
  };
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function assertTotalCents(totalCents: number): void {
  if (!Number.isInteger(totalCents)) {
    throw new Error(`totalCents must be an integer, got ${totalCents}`);
  }
  if (totalCents <= 0) {
    throw new Error(`totalCents must be > 0, got ${totalCents}`);
  }
  if (totalCents <= PLATFORM_FEE_CENTS) {
    throw new Error(
      `totalCents (${totalCents}) must exceed platform fee (${PLATFORM_FEE_CENTS})`,
    );
  }
}
