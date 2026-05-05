import { PrismaClient } from "@prisma/client";

// Referral network:
// Pedro → Carlos (level 1)
// Pedro → Marcos (level 1)
// Carlos → Roberto (level 1)
// Pedro → Roberto (level 2, via Carlos)
// Pedro → João (level 1)
const REFERRAL_NETWORK: Array<{ referrer: string; referred: string; level: number }> = [
  { referrer: "mottapedro01@gmail.com", referred: "carlos@driver.com",  level: 1 },
  { referrer: "mottapedro01@gmail.com", referred: "marcos@driver.com",  level: 1 },
  { referrer: "carlos@driver.com",      referred: "roberto@driver.com", level: 1 },
  { referrer: "mottapedro01@gmail.com", referred: "roberto@driver.com", level: 2 },
  { referrer: "mottapedro01@gmail.com", referred: "jlcbrito@driver.com", level: 1 },
];

export async function seedReferrals(prisma: PrismaClient) {
  for (const ref of REFERRAL_NETWORK) {
    const referrerUser = await prisma.user.findUnique({ where: { email: ref.referrer } });
    const referredUser = await prisma.user.findUnique({ where: { email: ref.referred } });

    if (!referrerUser || !referredUser) continue;

    const referrer = await prisma.driver.findUnique({ where: { userId: referrerUser.id } });
    const referred = await prisma.driver.findUnique({ where: { userId: referredUser.id } });

    if (!referrer || !referred) continue;

    await prisma.driverReferral.upsert({
      where: {
        referrerDriverId_referredDriverId: {
          referrerDriverId: referrer.id,
          referredDriverId: referred.id,
        },
      },
      update: {},
      create: {
        referrerDriverId: referrer.id,
        referredDriverId: referred.id,
        level: ref.level,
      },
    });

    console.log(`🔗 ${ref.referrer} → ${ref.referred} (level ${ref.level})`);
  }

  console.log(`✅ Referral network criada`);
}
