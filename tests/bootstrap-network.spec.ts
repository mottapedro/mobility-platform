import { prisma } from "./setup";
import { runBootstrapNetwork } from "../prisma/seeds/bootstrap-network";

describe("runBootstrapNetwork", () => {
  it("does not create duplicate users, drivers, regions, vehicles, or referral edges when run twice", async () => {
    await runBootstrapNetwork(prisma);
    await runBootstrapNetwork(prisma);

    expect(await prisma.user.count({ where: { role: "DRIVER" } })).toBe(10);
    expect(await prisma.vehicle.count()).toBe(10);
    expect(await prisma.driverReferral.count()).toBe(15);

    const pedro = await prisma.driver.findFirstOrThrow({ where: { referralCode: "pedro-paulo-motta-zn" } });
    const joao = await prisma.driver.findFirstOrThrow({ where: { referralCode: "joao-luiz-correa-de-brito-zn" } });
    const anselmo = await prisma.driver.findFirstOrThrow({ where: { referralCode: "anselmo-valle-dos-santos-zn" } });
    const fernando = await prisma.driver.findFirstOrThrow({ where: { referralCode: "fernando-barreira-zn" } });
    const andre = await prisma.driver.findFirstOrThrow({ where: { referralCode: "andre-cabral-zn" } });

    expect(joao.referredByDriverId).toBe(pedro.id);
    expect(anselmo.referredByDriverId).toBe(pedro.id);
    expect(fernando.referredByDriverId).toBe(pedro.id);
    expect(andre.referredByDriverId).toBe(joao.id);
  });
});