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

import { ActorType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { RootOwnershipProjectionService } from "../ownership/RootOwnershipProjectionService";
import { recordRelationship } from "../referral-network/ReferralRelationshipService";

type Db = typeof prisma;

export interface SyncResult {
  checked: number;
  repaired: number;
  skipped: number;
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

    // 3. Project each missing direct D2D referral into the V2 graph.
    //    recordRelationship is idempotent and resolves the correct rootDriverId.
    let repaired = 0;
    for (const g of gaps) {
      try {
        await recordRelationship(
          {
            inviterActorType: ActorType.DRIVER,
            inviterId: g.referrerDriverId,
            invitedActorType: ActorType.DRIVER,
            invitedId: g.referredDriverId,
          },
          db
        );
        repaired++;
      } catch (err) {
        console.warn(
          `[SyncProjectionJob] failed to record relationship for ${g.referredDriverId}:`,
          (err as Error)?.message
        );
      }
    }

    // 5. Ownership autocura: ensure Passenger/Ride/Settlement rootDriverId is consistent
    await RootOwnershipProjectionService.reconcileOwnership(db).catch((err) => {
      console.error("[SyncProjectionJob] ownership reconciliation failed", err);
    });

    return { checked, repaired, skipped };
  },
};
