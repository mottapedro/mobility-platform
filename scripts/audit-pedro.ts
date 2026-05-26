import { prisma } from "../src/infra/prisma/client";

async function main() {
  const u = await prisma.user.findFirst({
    where: { email: "mottapedro01@gmail.com" },
    select: { id: true, name: true, email: true, role: true },
  });
  console.log("USER:", JSON.stringify(u, null, 2));
  if (!u) return;

  const d = await prisma.driver.findFirst({
    where: { userId: u.id },
    select: { id: true, isActive: true, experienceLevel: true, publicSlug: true, referralCode: true, referredByDriverId: true, networkLevel: true },
  });
  console.log("DRIVER:", JSON.stringify(d, null, 2));
  if (!d) return;

  const rels = await prisma.referralRelationship.findMany({
    where: { OR: [{ inviterId: d.id }, { invitedId: d.id }, { rootDriverId: d.id }] },
    select: { id: true, inviterId: true, inviterActorType: true, invitedId: true, invitedActorType: true, flowType: true, rootDriverId: true },
  });
  console.log("RELATIONSHIPS:", JSON.stringify(rels, null, 2));

  // Check referredBy driver
  if (d.referredByDriverId) {
    const root = await prisma.driver.findUnique({
      where: { id: d.referredByDriverId },
      select: { id: true, publicSlug: true, referralCode: true },
    });
    console.log("REFERRED_BY DRIVER:", JSON.stringify(root, null, 2));
  }

  // Check passengers referred by Pedro
  const passengers = await prisma.passenger.findMany({
    where: { referredByDriverId: d.id },
    select: { id: true, referralCode: true, publicSlug: true, rootDriverId: true },
    take: 5,
  });
  console.log("PASSENGERS REFERRED BY PEDRO:", JSON.stringify(passengers, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
