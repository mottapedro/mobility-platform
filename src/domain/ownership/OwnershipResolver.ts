import { OwnerType } from "@prisma/client";

/**
 * ADR-004 — Ownership Resolution (v1)
 *
 * Única entidade autorizada a determinar o proprietário econômico de uma corrida.
 * Função pura: sem efeitos colaterais, sem acesso ao banco.
 *
 * V1 — resolução direta via passenger.rootDriverId.
 * Versões futuras poderão usar ReferralRelationship, Corporate, Franchise, etc.
 */

/** Versão do algoritmo de resolução. Incrementar quando a lógica mudar. */
export const OWNERSHIP_RESOLUTION_VERSION = 1;

/** Código da política de resolução MVP. */
export const OWNERSHIP_POLICY_CODE = "PASSENGER_ROOTDRIVER_DIRECT";

export interface OwnershipResolutionInput {
  /** rootDriverId do passageiro no momento da solicitação da corrida. */
  passengerRootDriverId: string | null;
}

export interface OwnershipResolution {
  ownerId: string | null;
  ownerType: OwnerType;
  ownershipPolicyCode: string;
  ownershipResolutionVersion: number;
  /** Descreve exatamente qual campo ou mecanismo foi consultado. */
  resolutionSource: string;
}

/**
 * Resolve o proprietário econômico de uma corrida.
 *
 * V1: lê diretamente o rootDriverId do passageiro.
 * O resultado deve ser persistido em OwnershipSnapshot imediatamente após a resolução.
 *
 * Futuramente, versões com resolutionSource diferente (ex: "referral_chain_depth_2")
 * poderão ser identificadas pelo campo ownershipResolutionVersion no snapshot histórico.
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
      ownershipResolutionVersion: OWNERSHIP_RESOLUTION_VERSION,
      resolutionSource: "passenger.rootDriverId",
    };
  }

  return {
    ownerId: null,
    ownerType: OwnerType.NONE,
    ownershipPolicyCode: OWNERSHIP_POLICY_CODE,
    ownershipResolutionVersion: OWNERSHIP_RESOLUTION_VERSION,
    resolutionSource: "passenger.rootDriverId",
  };
}
