import type { Prisma } from "@prisma/client";

export interface RevenuePolicySeedClient {
  revenuePolicy: {
    upsert(args: {
      where: { code_version: { code: string; version: number } };
      update: Prisma.RevenuePolicyUpdateInput;
      create: Prisma.RevenuePolicyCreateInput;
    }): PromiseLike<unknown>;
  };
}

/**
 * Seed das políticas de distribuição de receita operacional (ADR-002 v1.1).
 *
 * Idempotente: usa upsert por `code`. Pode ser executado múltiplas vezes
 * sem duplicar ou sobrescrever vigências históricas.
 */
export async function seedRevenuePolicies(prisma: RevenuePolicySeedClient) {
  console.log("💰 Seeding RevenuePolicy...");

  // Política padrão do MVP: Root Driver recebe 5% do driverNetAmount.
  // BPS = 500 (500 / 10_000 = 5%).
  await prisma.revenuePolicy.upsert({
    where: { code_version: { code: "ROOT_DRIVER_STANDARD", version: 1 } },
    update: {},
    create: {
      code: "ROOT_DRIVER_STANDARD",
      name: "Padrão — Root Driver 5%",
      version: 1,
      baseType: "OPERATIONAL_REVENUE",
      rootDriverBps: 500,
      effectiveFrom: null,
      effectiveUntil: null,
      isActive: true,
    },
  });

  console.log("  ✅ ROOT_DRIVER_STANDARD (500 bps / 5% / OPERATIONAL_REVENUE)");
}
