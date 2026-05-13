import { prisma } from "./setup";
import {
  createDriverReferralChain,
  getDriverNetwork,
} from "../src/domain/services/DriverReferralService";

jest.setTimeout(15000);

async function createDriver(email: string) {
  const user = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: "11999990000",
      role: "DRIVER",
      driver: { create: { experienceLevel: "PROFISSIONAL", isActive: true } },
    },
    include: { driver: true },
  });
  return user.driver!;
}

// ─── createDriverReferralChain ────────────────────────────────────────────
describe("createDriverReferralChain", () => {
  it("persists the direct parent edge using the rollout-safe driverId field", async () => {
    const driverA = await createDriver("direct-parent-a@ref.com");
    const driverB = await createDriver("direct-parent-b@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);

    const chain = await prisma.driverReferral.findFirst({
      where: { driverId: driverA.id, referredDriverId: driverB.id },
    });

    expect(chain).not.toBeNull();
    expect(chain!.level).toBe(1);
  });

  it("cria vínculo level 1 entre referrer e novo driver", async () => {
    const driverA = await createDriver("a@ref.com");
    const driverB = await createDriver("b@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);

    const chain = await prisma.driverReferral.findFirst({
      where: { driverId: driverA.id, referredDriverId: driverB.id },
    });
    expect(chain).not.toBeNull();
    expect(chain!.level).toBe(1);
  });

  it("herda nível 2 quando referrer já tem um nível 1", async () => {
    const driverA = await createDriver("a2@ref.com");
    const driverB = await createDriver("b2@ref.com");
    const driverC = await createDriver("c2@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id); // A→B level 1
    await createDriverReferralChain(driverC.id, driverB.id); // B→C, herda A→C level 2

    const level2 = await prisma.driverReferral.findFirst({
      where: { driverId: driverA.id, referredDriverId: driverC.id },
    });
    expect(level2).not.toBeNull();
    expect(level2!.level).toBe(2);
  });

  it("herda nível 3 e NÃO cria nível 4", async () => {
    const driverA = await createDriver("a3@ref.com");
    const driverB = await createDriver("b3@ref.com");
    const driverC = await createDriver("c3@ref.com");
    const driverD = await createDriver("d3@ref.com");
    const driverE = await createDriver("e3@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);
    await createDriverReferralChain(driverC.id, driverB.id);
    await createDriverReferralChain(driverD.id, driverC.id); // A→D level 3

    const level3 = await prisma.driverReferral.findFirst({
      where: { driverId: driverA.id, referredDriverId: driverD.id },
    });
    expect(level3!.level).toBe(3);

    await createDriverReferralChain(driverE.id, driverD.id); // A→E would be level 4 — must NOT exist

    const level4 = await prisma.driverReferral.findFirst({
      where: { driverId: driverA.id, referredDriverId: driverE.id },
    });
    expect(level4).toBeNull();
  });

  it("não cria duplicidade quando chamado duas vezes", async () => {
    const driverA = await createDriver("a4@ref.com");
    const driverB = await createDriver("b4@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);
    await createDriverReferralChain(driverB.id, driverA.id); // duplicata — deve ser ignorada

    const count = await prisma.driverReferral.count({
      where: { driverId: driverA.id, referredDriverId: driverB.id },
    });
    expect(count).toBe(1);
  });

  it("não cria self-referral", async () => {
    const driverA = await createDriver("self@ref.com");

    await createDriverReferralChain(driverA.id, driverA.id);

    const self = await prisma.driverReferral.findFirst({
      where: { driverId: driverA.id, referredDriverId: driverA.id },
    });
    expect(self).toBeNull();
  });
});

// ─── getDriverNetwork ─────────────────────────────────────────────────────
describe("getDriverNetwork", () => {
  it("retorna drivers agrupados por level 1, 2 e 3", async () => {
    const driverA = await createDriver("net_a@ref.com");
    const driverB = await createDriver("net_b@ref.com");
    const driverC = await createDriver("net_c@ref.com");
    const driverD = await createDriver("net_d@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);
    await createDriverReferralChain(driverC.id, driverB.id);
    await createDriverReferralChain(driverD.id, driverC.id);

    const network = await getDriverNetwork(driverA.id);

    expect(network.level1).toContain(driverB.id);
    expect(network.level2).toContain(driverC.id);
    expect(network.level3).toContain(driverD.id);
    expect(network.level1).not.toContain(driverC.id);
    expect(network.level2).not.toContain(driverD.id);
  });

  it("retorna arrays vazios quando driver não tem rede", async () => {
    const driverA = await createDriver("lonely@ref.com");

    const network = await getDriverNetwork(driverA.id);

    expect(network.level1).toHaveLength(0);
    expect(network.level2).toHaveLength(0);
    expect(network.level3).toHaveLength(0);
  });
});
