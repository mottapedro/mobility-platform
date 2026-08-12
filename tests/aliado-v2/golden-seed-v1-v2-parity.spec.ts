import { ActorType, ReferralFlowType } from "../../src/shared/enums";
import { disconnectPrisma, prisma } from "../../src/infra/prisma/client";
import { SyncProjectionJob } from "../../src/domain/network/SyncProjectionJob";
import { buildNetworkContextForDriver } from "../../src/domain/network/NetworkContextProjectionService";
import type { FrontendGenealogyNode } from "../../src/domain/network/NetworkContextTypes";

const PEDRO_EMAIL = "mottapedro01@gmail.com";
const JOAO_EMAIL = "jln@gmail.com";
const PETER_EMAIL = "peter.jackson@mobility.com";
const ANA_EMAIL = "ana.claudia.silva@mobility.com";
const ROBERTO_EMAIL = "roberto.souza@mobility.com";

const describeDisposable =
  process.env.GOLDEN_SEED_DISPOSABLE === "1" ? describe : describe.skip;

function canonicalTree(nodes: FrontendGenealogyNode[]): unknown[] {
  return nodes
    .map((node) => ({
      actorId: node.actor.id,
      actorType: node.actor.actorType,
      depth: node.depth,
      absoluteDepth: node.absoluteDepth,
      children: canonicalTree(node.children),
    }))
    .sort((a, b) => a.actorId.localeCompare(b.actorId));
}

function canonicalJoaoSnapshot(context: Awaited<ReturnType<typeof buildNetworkContextForDriver>>): string {
  return JSON.stringify({
    ancestors: context.genealogy.ancestors.map((actor) => actor.id),
    lateral: context.genealogy.lateral.map((actor) => actor.id).sort(),
    descendants: canonicalTree(context.genealogy.descendants),
    flowType: context.flowType,
    rootDriverId: context.rootDriver?.id ?? null,
  });
}

describeDisposable("Golden Seed V1/V2 direct D2D parity", () => {
  afterAll(async () => {
    await disconnectPrisma();
  });

  it("is complete before sync and preserves Joao's projection across two sync passes", async () => {
    const users = await prisma.user.findMany({
      where: {
        email: { in: [PEDRO_EMAIL, JOAO_EMAIL, PETER_EMAIL, ANA_EMAIL, ROBERTO_EMAIL] },
      },
      select: { email: true, driver: { select: { id: true } } },
    });
    const driverIdByEmail = new Map<string, string>();
    for (const user of users) {
      if (user.driver) driverIdByEmail.set(user.email, user.driver.id);
    }

    const pedroId = driverIdByEmail.get(PEDRO_EMAIL);
    const joaoId = driverIdByEmail.get(JOAO_EMAIL);
    const peterId = driverIdByEmail.get(PETER_EMAIL);
    const anaId = driverIdByEmail.get(ANA_EMAIL);
    const robertoId = driverIdByEmail.get(ROBERTO_EMAIL);
    expect([pedroId, joaoId, peterId, anaId, robertoId]).not.toContain(undefined);

    const directReferrals = await prisma.driverReferral.findMany({
      where: { isDirect: true },
      select: { referrerDriverId: true, referredDriverId: true },
    });
    const d2dRelationships = await prisma.referralRelationship.findMany({
      where: {
        inviterActorType: ActorType.DRIVER,
        invitedActorType: ActorType.DRIVER,
        flowType: ReferralFlowType.DRIVER_TO_DRIVER,
      },
      select: {
        inviterId: true,
        invitedId: true,
        flowType: true,
        rootDriverId: true,
      },
    });

    const referralPairs = directReferrals
      .map((edge) => `${edge.referrerDriverId}->${edge.referredDriverId}`)
      .sort();
    const relationshipPairs = d2dRelationships
      .map((edge) => `${edge.inviterId}->${edge.invitedId}`)
      .sort();

    expect(referralPairs).toHaveLength(13);
    expect(relationshipPairs).toHaveLength(13);
    expect(relationshipPairs).toEqual(referralPairs);

    const expectedLegacyEdges = [
      { inviterId: pedroId!, invitedId: peterId! },
      { inviterId: peterId!, invitedId: anaId! },
      { inviterId: pedroId!, invitedId: robertoId! },
    ];
    for (const expected of expectedLegacyEdges) {
      expect(d2dRelationships).toContainEqual({
        ...expected,
        flowType: ReferralFlowType.DRIVER_TO_DRIVER,
        rootDriverId: pedroId,
      });
    }

    const before = canonicalJoaoSnapshot(
      await buildNetworkContextForDriver(joaoId!, pedroId!, prisma)
    );
    const firstSync = await SyncProjectionJob.execute(prisma);
    const secondSync = await SyncProjectionJob.execute(prisma);
    const after = canonicalJoaoSnapshot(
      await buildNetworkContextForDriver(joaoId!, pedroId!, prisma)
    );

    expect(firstSync).toEqual({ checked: 13, repaired: 0, skipped: 13 });
    expect(secondSync).toEqual({ checked: 13, repaired: 0, skipped: 13 });
    expect(after).toBe(before);
  });
});
