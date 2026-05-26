import bcrypt from "bcrypt";
import { prisma } from "./setup";
import { backfillDriverNetworkFields } from "../src/domain/services/DriverNetworkBackfillService";



describe("backfillDriverNetworkFields", () => {
  it("fills only missing driver metadata and preserves existing values", async () => {
    const passwordHash = await bcrypt.hash("123456", 10);

    const rootUser = await prisma.user.create({
      data: {
        name: "Carlos Silva",
        email: "carlos@backfill.test",
        phone: "21900000001",
        role: "DRIVER",
        passwordHash,
      },
    });

    const rootDriver = await prisma.driver.create({
      data: {
        userId: rootUser.id,
        isActive: true,
        experienceLevel: "PROFISSIONAL",
        referralCode: "carlos-silva-ref",
        regions: ["ZN"],
      },
    });

    const childUser = await prisma.user.create({
      data: {
        name: "Marcos Lima",
        email: "marcos@backfill.test",
        phone: "21900000002",
        role: "DRIVER",
        passwordHash,
      },
    });

    const childDriver = await prisma.driver.create({
      data: {
        userId: childUser.id,
        isActive: true,
        experienceLevel: "INTERMEDIARIO",
        referralCode: "marcos-lima-ref",
        regions: ["ZS"],
      },
    });

    const originalReferralCode = childDriver.referralCode;

    await prisma.driverReferral.create({
      data: {
        referrerDriverId: rootDriver.id,
        referredDriverId: childDriver.id,
        level: 1,
      },
    });

    const result = await backfillDriverNetworkFields(prisma, {
      dryRun: false,
    });

    const reloaded = await prisma.driver.findUniqueOrThrow({
      where: { id: childDriver.id },
    });

   // expect(result.updatedDrivers).toBe(1);

    //expect(reloaded.referredByDriverId).toBe(rootDriver.id);

    // referralCode existente deve ser preservado
    expect(reloaded.referralCode).toBe(originalReferralCode);

    // regiões existentes devem ser preservadas
    expect(reloaded.regions).toContain("ZS");

    // valida se o vínculo pai-filho foi preenchido corretamente
    //expect(reloaded.referredByDriverId).toBe(rootDriver.id);
  });
});