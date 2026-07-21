import { PrismaClient } from "@prisma/client";

/**
 * Seed das políticas de resolução de ownership econômico (ADR-004 Step 2).
 *
 * Idempotente: usa upsert por `code_version`. Pode ser executado múltiplas vezes
 * sem duplicar ou sobrescrever vigências históricas.
 */
export async function seedOwnershipPolicies(prisma: PrismaClient) {
  console.log("🏛️  Seeding OwnershipPolicy...");

  // Política padrão do MVP: resolve ownership via passenger.rootDriverId.
  // V1 — sem travessia de grafo, leitura direta do campo desnormalizado.
  await prisma.ownershipPolicy.upsert({
    where: { code_version: { code: "PASSENGER_ROOTDRIVER_DIRECT", version: 1 } },
    update: {},
    create: {
      code: "PASSENGER_ROOTDRIVER_DIRECT",
      name: "Indicação Direta — passenger.rootDriverId",
      version: 1,
      resolutionStrategy: "PASSENGER_ROOTDRIVER_DIRECT",
      ownerType: "ROOT_DRIVER",
      effectiveFrom: null,
      effectiveUntil: null,
      isActive: true,
    },
  });

  console.log("  ✅ PASSENGER_ROOTDRIVER_DIRECT v1 (ROOT_DRIVER / PASSENGER_ROOTDRIVER_DIRECT)");
}
