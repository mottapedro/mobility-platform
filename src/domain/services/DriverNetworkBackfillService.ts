import { PrismaClient } from "@prisma/client";

// Backfill alinhado ao domínio referral/network novo.
// A rede agora é consumida via snapshot multinível dinâmico (getDriverNetworkSnapshot)
// e construída pela join table DriverReferral (referrerDriverId/referredDriverId).
// Neste merge, evitamos backfill acoplado a campos legados como publicSlug/networkLevel
// para não reintroduzir regressões estruturais.

export async function backfillDriverNetworkFields(
  _prisma: PrismaClient,
  _options: { dryRun: boolean }
) {
  return { updatedDrivers: 0 };
}

