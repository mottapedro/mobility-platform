import { prisma } from "./setup";
import { createDriverReferralChain } from "../src/domain/services/DriverReferralService";

async function mkDriver(name: string, email: string, phone: string, code: string) {
  const u = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      role: "DRIVER",
      driver: {
        create: { experienceLevel: "PROFISSIONAL", isActive: true, referralCode: code, regions: ["ZN"] },
      },
    },
    include: { driver: true },
  });
  return u.driver!;
}

describe("SQL validation — closure table", () => {
  it("materializa Pedro→João→Carlinhos com isDirect correto", async () => {
    const pedro     = await mkDriver("Pedro",     "pedro@sqlval.com",     "21940001111", "PEDV");
    const joao      = await mkDriver("João",      "joao@sqlval.com",      "21940002222", "JOAV");
    const carlinhos = await mkDriver("Carlinhos", "carlinhos@sqlval.com", "21940003333", "CARV");

    await createDriverReferralChain(joao.id, pedro.id);
    await createDriverReferralChain(carlinhos.id, joao.id);

    const rows = await prisma.driverReferral.findMany({
      where: {
        OR: [
          { referrerDriverId: { in: [pedro.id, joao.id, carlinhos.id] } },
          { referredDriverId:  { in: [pedro.id, joao.id, carlinhos.id] } },
        ],
      },
      orderBy: [{ level: "asc" }, { isDirect: "desc" }],
    });

    const ids: Record<string, string> = {
      [pedro.id]:     "Pedro",
      [joao.id]:      "João",
      [carlinhos.id]: "Carlinhos",
    };

    console.log("\n=== CLOSURE TABLE ===");
    console.log("referrer         -> referred        | level | isDirect");
    console.log("-".repeat(60));
    for (const r of rows) {
      const ref = (ids[r.referrerDriverId] ?? r.referrerDriverId.slice(0, 8)).padEnd(16);
      const red = (ids[r.referredDriverId] ?? r.referredDriverId.slice(0, 8)).padEnd(16);
      console.log(`${ref} -> ${red} | ${r.level}     | ${r.isDirect}`);
    }

    // ─── Assertions ──────────────────────────────────────────────────────────

    // 3 edges: Pedro→João(l1,direct), João→Carlinhos(l1,direct), Pedro→Carlinhos(l2,inherited)
    expect(rows).toHaveLength(3);

    const pedroJoao = rows.find(r => r.referrerDriverId === pedro.id && r.referredDriverId === joao.id)!;
    expect(pedroJoao.level).toBe(1);
    expect(pedroJoao.isDirect).toBe(true);

    const joaoCarlinhos = rows.find(r => r.referrerDriverId === joao.id && r.referredDriverId === carlinhos.id)!;
    expect(joaoCarlinhos.level).toBe(1);
    expect(joaoCarlinhos.isDirect).toBe(true);

    const pedroCarlinhos = rows.find(r => r.referrerDriverId === pedro.id && r.referredDriverId === carlinhos.id)!;
    expect(pedroCarlinhos.level).toBe(2);
    expect(pedroCarlinhos.isDirect).toBe(false);  // herdado

    // Snapshot: Pedro vê level1=[João] e level2=[Carlinhos]
    const snapshot = await import("../src/domain/services/DriverReferralService").then(m => m.getDriverNetworkSnapshot(pedro.id));
    const level1Ids = snapshot.levels.level1.map(n => n.driverId);
    const level2Ids = snapshot.levels.level2.map(n => n.driverId);
    expect(level1Ids).toContain(joao.id);
    expect(level2Ids).toContain(carlinhos.id);
  });
});
