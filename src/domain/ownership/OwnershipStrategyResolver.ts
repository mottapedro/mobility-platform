import { OwnershipPolicy, ResolutionStrategy } from "@prisma/client";

/**
 * ADR-004 Step 2 — mapeamento de OwnershipPolicy → dados para o OwnershipResolver.
 *
 * Padrão Strategy: cada ResolutionStrategy extrai os dados que o resolver puro
 * precisa. Adicionar uma nova estratégia significa:
 *   1. Adicionar o valor ao enum ResolutionStrategy no schema.
 *   2. Adicionar um case aqui com os inputs necessários.
 *   3. Não alterar o OwnershipResolver puro.
 *
 * O resolver puro permanece testável e sem acoplamento à persistência.
 */

export interface StrategyResolutionInput {
  /** rootDriverId do passageiro no momento da corrida (V1). */
  passengerRootDriverId: string | null;
  // Inputs futuros seriam adicionados aqui:
  // referralChainRootId?: string | null;    // V2 REFERRAL_CHAIN
  // corporateAccountId?: string | null;     // CORPORATE_ACCOUNT
  // franchiseOwnerId?: string | null;       // FRANCHISE_OWNER
}

export interface StrategyResolutionOutput {
  /** Identificador do owner resolvido; null = sem proprietário. */
  ownerId: string | null;
  /** Descreve exatamente qual campo/mecanismo foi consultado (auditabilidade). */
  resolutionSource: string;
}

/**
 * Mapeia uma OwnershipPolicy para o resultado de resolução usando a estratégia
 * indicada por policy.resolutionStrategy.
 *
 * Função pura: sem efeitos colaterais, sem acesso ao banco.
 */
export function resolveByStrategy(
  policy: OwnershipPolicy,
  input: StrategyResolutionInput,
): StrategyResolutionOutput {
  switch (policy.resolutionStrategy) {
    case ResolutionStrategy.PASSENGER_ROOTDRIVER_DIRECT:
      return {
        ownerId: input.passengerRootDriverId,
        resolutionSource: "passenger.rootDriverId",
      };

    // Estratégias futuras retornam seu próprio ownerId/resolutionSource:
    // case ResolutionStrategy.REFERRAL_CHAIN:
    //   return { ownerId: input.referralChainRootId ?? null, resolutionSource: "referral_chain" };
    // case ResolutionStrategy.CORPORATE_ACCOUNT:
    //   return { ownerId: input.corporateAccountId ?? null, resolutionSource: "corporate_account" };

    default:
      return { ownerId: null, resolutionSource: "unknown_strategy" };
  }
}
