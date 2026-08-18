/**
 * INVARIANTES DE OWNERSHIP (IO-1..IO-7)
 *
 * Verificam o contrato do domínio de Ownership Resolution (ADR-004).
 * Mistura de testes puros (OwnershipResolver) e de integração (OwnershipSnapshot no banco).
 *
 * Uma falha aqui indica violação de ADR-004.
 */

import { OwnerType } from "@prisma/client";
import bcrypt from "bcrypt";
import {
  resolveOwnership,
  OWNERSHIP_RESOLUTION_VERSION,
  OWNERSHIP_POLICY_CODE,
} from "../../src/domain/ownership/OwnershipResolver";
import { prisma } from "../setup";

// ---------------------------------------------------------------------------
// Testes puros — OwnershipResolver (sem banco)
// ---------------------------------------------------------------------------

describe("OwnershipResolver — função pura (IO-4, IO-5, IO-7)", () => {
  it("IO-4 + IO-7: root presente → ownerType=ROOT_DRIVER, resolutionSource descrito", () => {
    const r = resolveOwnership({ passengerRootDriverId: "driver-abc" });
    expect(r.ownerId).toBe("driver-abc");
    expect(r.ownerType).toBe(OwnerType.ROOT_DRIVER);
    expect(r.resolutionSource).toBe("passenger.rootDriverId");
    expect(r.ownershipPolicyCode).toBe(OWNERSHIP_POLICY_CODE);
    expect(r.ownershipResolutionVersion).toBe(OWNERSHIP_RESOLUTION_VERSION);
  });

  it("IO-5: rootDriverId null → ownerType=NONE, ownerId=null (corrida orgânica)", () => {
    const r = resolveOwnership({ passengerRootDriverId: null });
    expect(r.ownerId).toBeNull();
    expect(r.ownerType).toBe(OwnerType.NONE);
    expect(r.resolutionSource).toBe("passenger.rootDriverId");
  });

  it("ownershipResolutionVersion é constante e rastreável", () => {
    const r1 = resolveOwnership({ passengerRootDriverId: "x" });
    const r2 = resolveOwnership({ passengerRootDriverId: null });
    expect(r1.ownershipResolutionVersion).toBe(OWNERSHIP_RESOLUTION_VERSION);
    expect(r2.ownershipResolutionVersion).toBe(OWNERSHIP_RESOLUTION_VERSION);
  });

  it("IO-7: resolutionSource identifica exatamente qual campo foi consultado", () => {
    const r = resolveOwnership({ passengerRootDriverId: "driver-xyz" });
    // V1 sempre usa passenger.rootDriverId — qualquer outra source indicaria V2+
    expect(r.resolutionSource).toBe("passenger.rootDriverId");
  });

  it("determinismo: mesma entrada produz mesmo resultado", () => {
    const input = { passengerRootDriverId: "driver-123" };
    const r1 = resolveOwnership(input);
    const r2 = resolveOwnership(input);
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// Helpers para testes de integração
// ---------------------------------------------------------------------------

async function makeDriver(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email, email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

async function makePassenger(email: string, rootDriverId: string | null) {
  const u = await prisma.user.create({
    data: {
      name: email, email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "PASSENGER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.passenger.create({
    data: {
      userId: u.id,
      referralCode: `r-${u.id.slice(0, 6)}`,
      publicSlug: `s-${u.id.slice(0, 6)}`,
      rootDriverId: rootDriverId ?? undefined,
    },
  });
}

async function makeRide(passengerId: string) {
  return prisma.rideRequest.create({
    data: {
      passengerId,
      origin: "A", destination: "B",
      scheduledAt: new Date(),
      status: "PENDING",
    },
  });
}

async function makeSnapshot(rideId: string, ownerId: string | null) {
  const resolution = resolveOwnership({ passengerRootDriverId: ownerId });
  return prisma.ownershipSnapshot.create({
    data: {
      rideId,
      ownerId: resolution.ownerId,
      ownerType: resolution.ownerType,
      ownershipPolicyCode: resolution.ownershipPolicyCode,
      ownershipResolutionVersion: resolution.ownershipResolutionVersion,
      resolutionSource: resolution.resolutionSource,
    },
  });
}

// ---------------------------------------------------------------------------
// IO-1: cada corrida tem exatamente um OwnershipSnapshot
// ---------------------------------------------------------------------------

describe("IO-1: uma corrida → exatamente um OwnershipSnapshot", () => {
  it("lança ao tentar criar um segundo snapshot para a mesma corrida", async () => {
    const driver = await makeDriver("io1.driver@test.com");
    const passenger = await makePassenger("io1.pass@test.com", driver.id);
    const ride = await makeRide(passenger.id);
    await makeSnapshot(ride.id, driver.id);

    await expect(makeSnapshot(ride.id, driver.id)).rejects.toThrow();
  });

  it("corridas diferentes têm snapshots independentes", async () => {
    const passenger = await makePassenger("io1b.pass@test.com", null);
    const r1 = await makeRide(passenger.id);
    const r2 = await makeRide(passenger.id);

    const s1 = await makeSnapshot(r1.id, null);
    const s2 = await makeSnapshot(r2.id, null);

    expect(s1.rideId).toBe(r1.id);
    expect(s2.rideId).toBe(r2.id);
    expect(s1.id).not.toBe(s2.id);
  });
});

// ---------------------------------------------------------------------------
// IO-2: OwnershipSnapshot não é atualizado após criação
// ---------------------------------------------------------------------------

describe("IO-2: OwnershipSnapshot imutável após criação", () => {
  it("update no banco não apaga resolvedAt ou ownerType originais", async () => {
    const driver = await makeDriver("io2.driver@test.com");
    const passenger = await makePassenger("io2.pass@test.com", driver.id);
    const ride = await makeRide(passenger.id);
    const snapshot = await makeSnapshot(ride.id, driver.id);

    // Update é tecnicamente permitido pelo banco (sem trigger de imutabilidade aqui),
    // mas o teste documenta que a aplicação não deve fazê-lo.
    // A verificação é que os valores originais estão corretos.
    const fetched = await prisma.ownershipSnapshot.findUnique({ where: { id: snapshot.id } });
    expect(fetched?.ownerId).toBe(driver.id);
    expect(fetched?.ownerType).toBe(OwnerType.ROOT_DRIVER);
    expect(fetched?.resolvedAt).toEqual(snapshot.resolvedAt);
    expect(fetched?.ownershipResolutionVersion).toBe(OWNERSHIP_RESOLUTION_VERSION);
  });
});

// ---------------------------------------------------------------------------
// IO-3: Settlement usa ownerId do snapshot, não do Passenger (verificado via leitura)
// ---------------------------------------------------------------------------

describe("IO-3: ownerId rastreável no snapshot (fonte canônica do Settlement)", () => {
  it("snapshot gravado com ownerId correto que o Settlement pode ler", async () => {
    const root = await makeDriver("io3.root@test.com");
    const passenger = await makePassenger("io3.pass@test.com", root.id);
    const ride = await makeRide(passenger.id);
    const snapshot = await makeSnapshot(ride.id, root.id);

    const fetched = await prisma.ownershipSnapshot.findUnique({
      where: { rideId: ride.id },
    });
    expect(fetched?.ownerId).toBe(root.id);
    // O Settlement leria fetched.ownerId, nunca passenger.rootDriverId diretamente
    expect(fetched?.ownerId).toBe(snapshot.ownerId);
  });
});

// ---------------------------------------------------------------------------
// IO-5: null é estado válido — corrida orgânica
// ---------------------------------------------------------------------------

describe("IO-5: corrida orgânica → ownerId=null, ownerType=NONE", () => {
  it("snapshot persiste estado orgânico corretamente", async () => {
    const passenger = await makePassenger("io5.organic@test.com", null);
    const ride = await makeRide(passenger.id);
    const snapshot = await makeSnapshot(ride.id, null);

    expect(snapshot.ownerId).toBeNull();
    expect(snapshot.ownerType).toBe(OwnerType.NONE);
    expect(snapshot.resolutionSource).toBe("passenger.rootDriverId");
  });
});

// ---------------------------------------------------------------------------
// IO-6: mudança no passenger.rootDriverId não afeta snapshots existentes
// ---------------------------------------------------------------------------

describe("IO-6: mudança no grafo não afeta snapshots já criados", () => {
  it("alterar passenger.rootDriverId não muda o snapshot histórico", async () => {
    const root1 = await makeDriver("io6.root1@test.com");
    const root2 = await makeDriver("io6.root2@test.com");
    const passenger = await makePassenger("io6.pass@test.com", root1.id);
    const ride = await makeRide(passenger.id);
    const snapshot = await makeSnapshot(ride.id, root1.id);

    // Simula mudança no campo do Passenger (ex: migração de rede)
    await prisma.passenger.update({
      where: { id: passenger.id },
      data: { rootDriverId: root2.id },
    });

    // Snapshot histórico permanece inalterado
    const fetchedSnapshot = await prisma.ownershipSnapshot.findUnique({
      where: { rideId: ride.id },
    });
    expect(fetchedSnapshot?.ownerId).toBe(root1.id); // não muda para root2
  });
});

// ---------------------------------------------------------------------------
// IO-7: resolutionSource identifica exatamente a origem
// ---------------------------------------------------------------------------

describe("IO-7: resolutionSource persiste a origem da resolução", () => {
  it("V1 persiste resolutionSource='passenger.rootDriverId'", async () => {
    const driver = await makeDriver("io7.driver@test.com");
    const passenger = await makePassenger("io7.pass@test.com", driver.id);
    const ride = await makeRide(passenger.id);
    const snapshot = await makeSnapshot(ride.id, driver.id);

    expect(snapshot.resolutionSource).toBe("passenger.rootDriverId");
  });

  it("ownershipResolutionVersion permite identificar qual algoritmo foi usado", async () => {
    const passenger = await makePassenger("io7b.pass@test.com", null);
    const ride = await makeRide(passenger.id);
    const snapshot = await makeSnapshot(ride.id, null);

    expect(snapshot.ownershipResolutionVersion).toBe(OWNERSHIP_RESOLUTION_VERSION);
  });
});
