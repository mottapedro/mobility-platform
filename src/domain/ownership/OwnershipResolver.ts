import { OwnershipPolicy, OwnerType } from "@prisma/client";
import { resolveByStrategy, type StrategyResolutionInput } from "./OwnershipStrategyResolver";

/**
 * ADR-004 — Ownership Resolution
 *
 * Única entidade autorizada a determinar o proprietário econômico de uma corrida.
 * Funções puras: sem efeitos colaterais, sem acesso ao banco.
 *
 * V1 — resolução direta via passenger.rootDriverId (sem política).
 * V2 — aceita OwnershipPolicy como parâmetro; delega à estratégia via OwnershipStrategyResolver.
 *
 * Evolução de algoritmo: incrementar OWNERSHIP_RESOLUTION_VERSION quando a lógica
 * de resolução mudar (não quando a política mudar). Políticas são dados.
 */

/** Versão do algoritmo de resolução. Incrementar quando a lógica do resolver mudar. */
export const OWNERSHIP_RESOLUTION_VERSION = 1;

/** Código da política padrão do MVP. */
export const OWNERSHIP_POLICY_CODE = "PASSENGER_ROOTDRIVER_DIRECT";

export interface OwnershipResolutionInput {
  /** rootDriverId do passageiro no momento da solicitação da corrida. */
  passengerRootDriverId: string | null;
}

export interface OwnershipResolution {
  ownerId: string | null;
  ownerType: OwnerType;
  ownershipPolicyCode: string;
  /** ID da OwnershipPolicy usada (null em resoluções V1 sem política). */
  ownershipPolicyId: string | null;
  /** Versão da OwnershipPolicy usada (null em resoluções V1 sem política). */
  ownershipPolicyVersion: number | null;
  ownershipResolutionVersion: number;
  /** Descreve exatamente qual campo ou mecanismo foi consultado. */
  resolutionSource: string;
}

/**
 * V1 — resolve sem política explícita (compatibilidade retroativa).
 * Produce ownershipPolicyId/Version = null — use resolveOwnershipV2 para novas corridas.
 */
export function resolveOwnership(
  input: OwnershipResolutionInput,
): OwnershipResolution {
  const { passengerRootDriverId } = input;

  if (passengerRootDriverId !== null) {
    return {
      ownerId: passengerRootDriverId,
      ownerType: OwnerType.ROOT_DRIVER,
      ownershipPolicyCode: OWNERSHIP_POLICY_CODE,
      ownershipPolicyId: null,
      ownershipPolicyVersion: null,
      ownershipResolutionVersion: OWNERSHIP_RESOLUTION_VERSION,
      resolutionSource: "passenger.rootDriverId",
    };
  }

  return {
    ownerId: null,
    ownerType: OwnerType.NONE,
    ownershipPolicyCode: OWNERSHIP_POLICY_CODE,
    ownershipPolicyId: null,
    ownershipPolicyVersion: null,
    ownershipResolutionVersion: OWNERSHIP_RESOLUTION_VERSION,
    resolutionSource: "passenger.rootDriverId",
  };
}

/**
 * V2 — resolve com OwnershipPolicy explícita.
 *
 * Recebe a política por injeção (já resolvida pelo OwnershipPolicyRepository),
 * delega a extração do ownerId ao OwnershipStrategyResolver, e retorna o resultado
 * com auditabilidade completa (policyId + policyVersion).
 *
 * Função pura: os dados chegam como parâmetros, não são buscados internamente.
 */
export function resolveOwnershipV2(input: {
  policy: OwnershipPolicy;
  strategyInput: StrategyResolutionInput;
}): OwnershipResolution {
  const { policy, strategyInput } = input;
  const strategyResult = resolveByStrategy(policy, strategyInput);

  const ownerType =
    strategyResult.ownerId !== null ? policy.ownerType : OwnerType.NONE;

  return {
    ownerId: strategyResult.ownerId,
    ownerType,
    ownershipPolicyCode: policy.code,
    ownershipPolicyId: policy.id,
    ownershipPolicyVersion: policy.version,
    ownershipResolutionVersion: OWNERSHIP_RESOLUTION_VERSION,
    resolutionSource: strategyResult.resolutionSource,
  };
}
