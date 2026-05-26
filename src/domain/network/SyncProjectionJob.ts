/**
 * SyncProjectionJob
 *
 * Detects and repairs divergence between the DriverReferral write model
 * and the ReferralRelationship read/projection model.
 *
 * A gap exists when a DriverReferral row (isDirect=true) has no corresponding
 * ReferralRelationship (invitedActorType=DRIVER, invitedId=referredDriverId).
 *
 * Idempotent — uses createMany({ skipDuplicates: true }) and the existing
 * @@unique([invitedActorType, invitedId]) constraint on ReferralRelationship.
 */

import { ActorType, ReferralFlowType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";

type Db = Pick<typeof prisma, "driverReferral" | "referralRelationship" | "driver">;

export interface SyncResult {
  checked: number;
  repaired: number;
  skipped: number;
}

/**
 * Walk Driver.referredByDriverId chain upward until reaching a root
 * (driver with no referredByDriverId). Max 20 hops guards against cycles.
 * Returns the input driverId itself if no chain exists.
 */
async function resolveRootDriverId(startDriverId: string, db: Db): Promise<string> {
  let current = startDriverId;
  for (let i = 0; i < 20; i++) {
    const d = await db.driver.findUnique({
      where: { id: current },
      select: { referredByDriverId: true },
    });
    if (!d || !d.referredByDriverId) return current;
    current = d.referredByDriverId;
  }
  return current;
}

export const SyncProjectionJob = {
  /**
   * Execute one reconciliation pass.
   *
   * @param db  Prisma client — injectable for testing.
   * @returns   Summary counts: checked = total direct D2D referrals examined,
   *            repaired = new ReferralRelationship rows created,
   *            skipped  = rows that already had a projection (no repair needed).
   */
  async execute(db: Db = prisma): Promise<SyncResult> {
    // 1. Load all direct D2D DriverReferral pairs
    const directReferrals = await db.driverReferral.findMany({
      where: { isDirect: true },
      select: { referrerDriverId: true, referredDriverId: true },
    });

    if (directReferrals.length === 0) {
      return { checked: 0, repaired: 0, skipped: 0 };
    }

    // 2. Find which referredDriverIds already have a ReferralRelationship
    const referredIds = directReferrals.map((r) => r.referredDriverId);
    const existing = await db.referralRelationship.findMany({
      where: {
        invitedActorType: ActorType.DRIVER,
        invitedId: { in: referredIds },
      },
      select: { invitedId: true },
    });
    const existingSet = new Set(existing.map((e) => e.invitedId));

    const gaps = directReferrals.filter((r) => !existingSet.has(r.referredDriverId));
    const checked = directReferrals.length;
    const skipped = checked - gaps.length;

    if (gaps.length === 0) {
      return { checked, repaired: 0, skipped };
    }

    // 3. Resolve rootDriverId for each gap (via referredByDriverId chain)
    const rows = await Promise.all(
      gaps.map(async (g) => {
        const rootDriverId = await resolveRootDriverId(g.referredDriverId, db);
        return {
          flowType: ReferralFlowType.DRIVER_TO_DRIVER,
          inviterActorType: ActorType.DRIVER,
          inviterId: g.referrerDriverId,
          invitedActorType: ActorType.DRIVER,
          invitedId: g.referredDriverId,
          rootDriverId,
          inviterDriverId: g.referrerDriverId,
        };
      })
    );

    // 4. Create missing rows — skipDuplicates for idempotency
    const result = await db.referralRelationship.createMany({
      data: rows,
      skipDuplicates: true,
    });

    return { checked, repaired: result.count, skipped };
  },
};
