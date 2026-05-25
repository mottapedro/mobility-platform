import bcrypt from "bcrypt";
import { ActorType } from "../../src/shared/enums";
import { prisma } from "../setup";
import { createDriverReferralChain } from "../../src/domain/services/DriverReferralService";
import { resolveDriverRoot } from "../../src/domain/referral-network/DriverRootResolverService";

async function makeDriver(name: string, email: string) {
  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: user.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

describe("DriverRootResolverService", () => {
  it("returns the driver itself when there is no referrer", async () => {
    const root = await makeDriver("Root A", "root.a@test.com");
    await expect(resolveDriverRoot(ActorType.DRIVER, root.id)).resolves.toBe(root.id);
  });

  it("resolves to the top of a 3-level driver chain", async () => {
    const root = await makeDriver("Root B", "root.b@test.com");
    const mid = await makeDriver("Mid B", "mid.b@test.com");
    const leaf = await makeDriver("Leaf B", "leaf.b@test.com");

    await prisma.driver.update({ where: { id: mid.id }, data: { referredByDriverId: root.id } });
    await prisma.driver.update({ where: { id: leaf.id }, data: { referredByDriverId: mid.id } });
    await createDriverReferralChain(mid.id, root.id);
    await createDriverReferralChain(leaf.id, mid.id);

    // sanity — closure mid→root and leaf→root must exist
    const closure = await prisma.driverReferral.findMany({
      where: { referredDriverId: leaf.id },
      orderBy: { level: "desc" },
    });
    expect(closure.length).toBeGreaterThan(0);

    await expect(resolveDriverRoot(ActorType.DRIVER, leaf.id)).resolves.toBe(root.id);
  });

  it("resolves a passenger root via referredByDriverId", async () => {
    const root = await makeDriver("Root C", "root.c@test.com");
    const u = await prisma.user.create({
      data: {
        name: "Pax C",
        email: "pax.c@test.com",
        phone: "21900000999",
        role: "PASSENGER",
        passwordHash: await bcrypt.hash("x", 4),
      },
    });
    const p = await prisma.passenger.create({
      data: {
        userId: u.id,
        referralCode: "pax-c",
        publicSlug: "pax-c",
        referredByDriverId: root.id,
      },
    });

    await expect(resolveDriverRoot(ActorType.PASSENGER, p.id)).resolves.toBe(root.id);
  });
});
