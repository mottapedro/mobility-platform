import bcrypt from "bcrypt";
import { ActorType, ReferralFlowType } from "../../src/shared/enums";
import { prisma } from "../setup";
import {
  recordRelationship,
  listRelationshipsForRoot,
} from "../../src/domain/referral-network/ReferralRelationshipService";
import { ReferralRelationshipError } from "../../src/domain/referral-network/errors";

async function makeDriver(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

describe("ReferralRelationshipService", () => {
  it("records and is idempotent on repeat call", async () => {
    const inviter = await makeDriver("inviter.r1@test.com");
    const invited = await makeDriver("invited.r1@test.com");

    const a = await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: inviter.id,
      invitedActorType: ActorType.DRIVER,
      invitedId: invited.id,
    });
    const b = await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: inviter.id,
      invitedActorType: ActorType.DRIVER,
      invitedId: invited.id,
    });

    expect(a.id).toBe(b.id);
    expect(a.flowType).toBe(ReferralFlowType.DRIVER_TO_DRIVER);
    expect(a.rootDriverId).toBe(inviter.id);
  });

  it("rejects self-referral", async () => {
    const d = await makeDriver("self.r2@test.com");
    await expect(
      recordRelationship({
        inviterActorType: ActorType.DRIVER,
        inviterId: d.id,
        invitedActorType: ActorType.DRIVER,
        invitedId: d.id,
      })
    ).rejects.toBeInstanceOf(ReferralRelationshipError);
  });

  it("listRelationshipsForRoot filters by rootDriverId", async () => {
    const root = await makeDriver("root.r3@test.com");
    const child1 = await makeDriver("c1.r3@test.com");
    const child2 = await makeDriver("c2.r3@test.com");

    await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedActorType: ActorType.DRIVER,
      invitedId: child1.id,
    });
    await recordRelationship({
      inviterActorType: ActorType.DRIVER,
      inviterId: root.id,
      invitedActorType: ActorType.DRIVER,
      invitedId: child2.id,
    });

    const rows = await listRelationshipsForRoot(root.id);
    expect(rows.length).toBe(2);
  });
});
