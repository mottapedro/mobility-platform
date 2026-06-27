import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🧭 Iniciando mapeamento de Zonas Operacionais...');

  // 1. Criar as Zonas Padrão do Rio de Janeiro
  const zones = ['Zona Oeste', 'Zona Norte', 'Zona Sul', 'Centro', 'Baixada Fluminense'];
  const createdZones = [];

  for (const zoneName of zones) {
    const zone = await prisma.operationalZone.upsert({
      where: { name: zoneName },
      update: {},
      create: {
        name: zoneName,
        description: `Cobertura prioritária: ${zoneName}`,
        isActive: true,
      },
    });
    createdZones.push(zone);
    console.log(`✅ Zona configurada: ${zone.name}`);
  }

  // 2. Buscar todos os motoristas ativos na base
  const drivers = await prisma.driver.findMany({
    where: { isActive: true },
    select: { id: true }
  });

  if (drivers.length === 0) {
    console.log('⚠️ Nenhum motorista encontrado para vincular.');
    return;
  }

  // 3. Distribuir os motoristas entre as zonas (Round-Robin)
  console.log(`🧩 Vinculando ${drivers.length} motoristas às zonas...`);
  let linksCreated = 0;

  for (let i = 0; i < drivers.length; i++) {
    const driver = drivers[i];
    const targetZone = createdZones[i % createdZones.length]; // Distribuição uniforme

    await prisma.driverOperationalZone.upsert({
      where: {
        driverId_zoneId: { driverId: driver.id, zoneId: targetZone.id }
      },
      update: {},
      create: {
        driverId: driver.id,
        zoneId: targetZone.id
      }
    });
    linksCreated++;
  }

  console.log(`🚀 Mapeamento concluído! ${linksCreated} vínculos Driver <-> Zone criados.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });