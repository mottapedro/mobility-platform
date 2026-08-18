import { RevenuePolicy } from "@prisma/client";
import type { ExtendedPrismaClient } from "../../infra/prisma/client";

export class RevenuePolicyRepository {
  constructor(private readonly db: ExtendedPrismaClient) {}

  /**
   * Resolve a política ativa para um dado `code` e data de referência.
   *
   * Critério de vigência (AND lógico):
   *   - isActive = true
   *   - effectiveFrom <= referenceDate  (ou effectiveFrom IS NULL)
   *   - effectiveUntil > referenceDate  (ou effectiveUntil IS NULL)
   *
   * Retorna `null` quando nenhuma política aplicável existir — o chamador
   * deve tratar este caso como erro de Validation Gate (VG-2).
   */
  async findActivePolicy(
    code: string,
    referenceDate: Date = new Date(),
  ): Promise<RevenuePolicy | null> {
    return this.db.revenuePolicy.findFirst({
      where: {
        code,
        isActive: true,
        OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: referenceDate } }],
        AND: [
          {
            OR: [
              { effectiveUntil: null },
              { effectiveUntil: { gt: referenceDate } },
            ],
          },
        ],
      },
      orderBy: { version: "desc" },
    });
  }

  /**
   * Resolve a política aplicável a uma corrida, usando a data do Settlement
   * como referência temporal.
   *
   * Para o MVP, o code padrão é ROOT_DRIVER_STANDARD. Futuramente o caller
   * poderá passar o code correto com base em campanha, região ou motorista.
   */
  async resolveForRide(
    rideDate: Date,
    policyCode = "ROOT_DRIVER_STANDARD",
  ): Promise<RevenuePolicy | null> {
    return this.findActivePolicy(policyCode, rideDate);
  }
}
