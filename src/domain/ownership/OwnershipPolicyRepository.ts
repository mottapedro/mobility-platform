import { OwnershipPolicy } from "@prisma/client";
import type { ExtendedPrismaClient } from "../../infra/prisma/client";

/**
 * ADR-004 Step 2 — repositório de OwnershipPolicy.
 *
 * Resolve qual política de ownership está vigente para uma data de referência.
 * Mesmo padrão temporal de RevenuePolicyRepository: effectiveFrom/effectiveUntil,
 * isActive, version desc.
 */
export class OwnershipPolicyRepository {
  constructor(private readonly db: ExtendedPrismaClient) {}

  async findActivePolicy(
    code: string,
    referenceDate: Date = new Date(),
  ): Promise<OwnershipPolicy | null> {
    return this.db.ownershipPolicy.findFirst({
      where: {
        code,
        isActive: true,
        OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: referenceDate } }],
        AND: [
          { OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: referenceDate } }] },
        ],
      },
      orderBy: { version: "desc" },
    });
  }

  async resolveForRide(
    rideDate: Date,
    strategyCode = "PASSENGER_ROOTDRIVER_DIRECT",
  ): Promise<OwnershipPolicy | null> {
    return this.findActivePolicy(strategyCode, rideDate);
  }
}
