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
      driver: {
        create: {
          experienceLevel: "PROFISSIONAL",
          isActive: true,
          regions: ["SP"],
        },
      },
    },
    include: { driver: true },
  });
  return user.driver!;
}

// ─── createDriverReferralChain ────────────────────────────────────────────
describe("createDriverReferralChain", () => {
  it("persists the direct parent edge with referrerDriverId and isDirect=true", async () => {
    const driverA = await createDriver("direct-parent-a@ref.com");
    const driverB = await createDriver("direct-parent-b@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);

    const chain = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverA.id, referredDriverId: driverB.id },
    });

    expect(chain).not.toBeNull();
    expect(chain!.level).toBe(1);
    expect(chain!.isDirect).toBe(true);
  });

  it("cria vínculo level 1 entre referrer e novo driver", async () => {
    const driverA = await createDriver("a@ref.com");
    const driverB = await createDriver("b@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);

    const chain = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverA.id, referredDriverId: driverB.id },
    });
    expect(chain).not.toBeNull();
    expect(chain!.level).toBe(1);
    expect(chain!.isDirect).toBe(true);
  });

  it("herda nível 2 quando referrer já tem um nível 1", async () => {
    const driverA = await createDriver("a2@ref.com");
    const driverB = await createDriver("b2@ref.com");
    const driverC = await createDriver("c2@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id); // A→B level 1 (direct)
    await createDriverReferralChain(driverC.id, driverB.id); // B→C level 1 (direct), A→C level 2 (inherited)

    const level2 = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverA.id, referredDriverId: driverC.id },
    });
    expect(level2).not.toBeNull();
    expect(level2!.level).toBe(2);
    expect(level2!.isDirect).toBe(false);
  });

  it("herda até nível 5 e NÃO cria nível 6", async () => {
    const driverA = await createDriver("a3@ref.com");
    const driverB = await createDriver("b3@ref.com");
    const driverC = await createDriver("c3@ref.com");
    const driverD = await createDriver("d3@ref.com");
    const driverE = await createDriver("e3@ref.com");
    const driverF = await createDriver("f3@ref.com");
    const driverG = await createDriver("g3@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);
    await createDriverReferralChain(driverC.id, driverB.id);
    await createDriverReferralChain(driverD.id, driverC.id); // A→D level 3

    const level3 = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverA.id, referredDriverId: driverD.id },
    });
    expect(level3!.level).toBe(3);
    expect(level3!.isDirect).toBe(false);

    await createDriverReferralChain(driverE.id, driverD.id); // A→E level 4
    await createDriverReferralChain(driverF.id, driverE.id); // A→F level 5
    await createDriverReferralChain(driverG.id, driverF.id); // A→G would be level 6 — must NOT exist

    const level4 = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverA.id, referredDriverId: driverE.id },
    });
    expect(level4).not.toBeNull();
    expect(level4!.level).toBe(4);

    const level5 = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverA.id, referredDriverId: driverF.id },
    });
    expect(level5).not.toBeNull();
    expect(level5!.level).toBe(5);

    const level6 = await prisma.driverReferral.findFirst({
      where: { referrerDriverId: driverA.id, referredDriverId: driverG.id },
    });
    expect(level6).toBeNull();
  });

  it("não cria duplicidade quando chamado duas vezes", async () => {
    const driverA = await createDriver("a4@ref.com");
    const driverB = await createDriver("b4@ref.com");

    await createDriverReferralChain(driverB.id, driverA.id);
    await createDriverReferralChain(driverB.id, driverA.id); // duplicata — deve ser ignorada

    const count = await prisma.driverReferral.count({
      where: { referrerDriverId: driverA.id, referredDriverId: driverB.id },
    });
    expect(count).toBe(1);
  });

  it("não cria self-referral — lança ReferralChainError", async () => {
    const driverA = await createDriver("self@ref.com");

    await expect(
      createDriverReferralChain(driverA.id, driverA.id)
    ).rejects.toThrow("autoindicação");

    const count = await prisma.driverReferral.count({
      where: { referrerDriverId: driverA.id, referredDriverId: driverA.id },
    });
    expect(count).toBe(0);
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
