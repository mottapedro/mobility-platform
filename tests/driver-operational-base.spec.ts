// Driver Operational Base — self-service (Fase E).
//
//   GET /drivers/me/operational-base  (Bearer) → 200 { operationalBase | null }
//   PUT /drivers/me/operational-base  (Bearer) → 200 base persistida / 4xx
//
// Cobre: auth Bearer (401 sem token, sessão revogada, x-driver-id ignorado),
// isolamento entre drivers, upsert idempotente, rejeição de providerPlaceId
// ausente, e a regra de segurança de coordenadas: lat/lng fora de faixa são
// sanitizados, o serviço NUNCA fabrica (0,0) (base sem geometria → 422
// BASE_NOT_RESOLVABLE) e, em dev sem GOOGLE_PLACES_API_KEY, coordenadas
// clientes dentro dos limites físicos são o pass-through persistido.

/// <reference types="jest" />
import request from "supertest";
import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma, cleanTestData } from "./setup";
import { AuthTokenService } from "../src/domain/auth/AuthTokenService";
import { AuthSessionService } from "../src/domain/auth/AuthSessionService";
import { useRevenuePolicyFixture } from "./fixtures/revenue-policy.fixture";
import { matchingJobScheduler } from "../src/infra/async/MatchingJobScheduler";

jest.setTimeout(20000);

const policyFixture = useRevenuePolicyFixture(prisma, cleanTestData);

const TEST_PASSWORD = "123456";
const DENIED_ERROR = "Driver authentication required";

let seq = 0;
function tag() {
  seq += 1;
  return `${Date.now()}.${seq}`;
}

async function createDriverUser(email: string) {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const user = await prisma.user.create({
    data: {
      name: "Operational Base Driver",
      email,
      phone: "11998887777",
      role: "DRIVER",
      passwordHash,
    },
  });
  const driver = await prisma.driver.create({
    data: {
      userId: user.id,
      isActive: true,
      experienceLevel: "INTERMEDIARIO",
      regions: ["ZN"],
    },
  });
  return { user, driver };
}

async function login(email: string) {
  const res = await request(app).post("/auth/login").send({ email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

function getBase(token: string) {
  return request(app)
    .get("/drivers/me/operational-base")
    .set("Authorization", `Bearer ${token}`);
}

function putBase(token: string, body: Record<string, unknown>) {
  return request(app)
    .put("/drivers/me/operational-base")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

describe("GET /drivers/me/operational-base — Bearer auth e leitura", () => {
  it("401 sem token (Bearer obrigatório)", async () => {
    await createDriverUser(`opb.none.${tag()}@test.com`);

    const res = await request(app).get("/drivers/me/operational-base");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("401 e ignora x-driver-id quando não há Bearer", async () => {
    const { driver } = await createDriverUser(`opb.xid.${tag()}@test.com`);

    const res = await request(app)
      .get("/drivers/me/operational-base")
      .set("x-driver-id", driver.id);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("401 para token com sessão revogada", async () => {
    const { user } = await createDriverUser(`opb.revoked.${tag()}@test.com`);
    const issued = await new AuthSessionService().createSession(user.id);
    await prisma.authSession.update({
      where: { id: issued.session.id },
      data: { revokedAt: new Date() },
    });
    const accessToken = await new AuthTokenService().issueAccessToken({
      userId: user.id,
      sessionId: issued.session.id,
    });

    const res = await getBase(accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("401 para token com sid inexistente", async () => {
    const { user } = await createDriverUser(`opb.nosid.${tag()}@test.com`);
    const accessToken = await new AuthTokenService().issueAccessToken({
      userId: user.id,
      sessionId: randomUUID(),
    });

    const res = await getBase(accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("200 com operationalBase null quando ainda não configurada", async () => {
    const email = `opb.empty.${tag()}@test.com`;
    await createDriverUser(email);
    const token = await login(email);

    const res = await getBase(token);

    expect(res.status).toBe(200);
    expect(res.body.operationalBase).toBeNull();
  });
});

describe("PUT /drivers/me/operational-base — auth, upsert e isolamento", () => {
  it("401 sem token (Bearer obrigatório)", async () => {
    await createDriverUser(`opb.put.none.${tag()}@test.com`);

    const res = await request(app)
      .put("/drivers/me/operational-base")
      .send({ providerPlaceId: "ChIJ_test", formattedAddress: "Centro" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("persiste a base (upsert) e GET retorna a mesma base", async () => {
    const email = `opb.create.${tag()}@test.com`;
    const { driver } = await createDriverUser(email);
    const token = await login(email);

    const put = await putBase(token, {
      providerPlaceId: "ChIJ_operational_001",
      formattedAddress: "Av. Paulista, 1000, São Paulo, SP",
      latitude: -23.5614,
      longitude: -46.6559,
    });

    expect(put.status).toBe(200);
    expect(put.body.operationalBase).toBeTruthy();
    expect(put.body.operationalBase.driverId).toBe(driver.id);
    expect(put.body.operationalBase.providerPlaceId).toBe("ChIJ_operational_001");
    expect(put.body.operationalBase.formattedAddress).toBe(
      "Av. Paulista, 1000, São Paulo, SP",
    );
    expect(put.body.source).toBe("CLIENT_FALLBACK");
    // Sem chave do Google, as coordenadas pass-through do cliente são
    // persistidas — mas NUNCA (0,0) (defeito que inflava a perna M→A).
    expect(put.body.operationalBase.latitude).toBe(-23.5614);
    expect(put.body.operationalBase.longitude).toBe(-46.6559);

    const get = await getBase(token);
    expect(get.status).toBe(200);
    expect(get.body.operationalBase.id).toBe(put.body.operationalBase.id);
    expect(get.body.operationalBase.providerPlaceId).toBe("ChIJ_operational_001");

    const rows = await prisma.driverOperationalBase.count({
      where: { driverId: driver.id },
    });
    expect(rows).toBe(1);
  });

  it("PUT repetido faz upsert idempotente (1 linha, endereço atualizado)", async () => {
    const email = `opb.update.${tag()}@test.com`;
    const { driver } = await createDriverUser(email);
    const token = await login(email);

    await putBase(token, {
      providerPlaceId: "ChIJ_operational_old",
      formattedAddress: "Endereço antigo",
      latitude: -23.55,
      longitude: -46.63,
    });

    const second = await putBase(token, {
      providerPlaceId: "ChIJ_operational_new",
      formattedAddress: "Endereço novo",
      latitude: -23.56,
      longitude: -46.64,
    });

    expect(second.status).toBe(200);
    expect(second.body.operationalBase.formattedAddress).toBe("Endereço novo");
    const rows = await prisma.driverOperationalBase.findMany({
      where: { driverId: driver.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].providerPlaceId).toBe("ChIJ_operational_new");
    expect(rows[0].latitude).toBe(-23.56);
  });

  it("isolamento: base de A não vaza para B; B continua null", async () => {
    const emailA = `opb.iso.a.${tag()}@test.com`;
    const emailB = `opb.iso.b.${tag()}@test.com`;
    const { driver: driverA } = await createDriverUser(emailA);
    const { driver: driverB } = await createDriverUser(emailB);
    const tokenA = await login(emailA);
    const tokenB = await login(emailB);

    const putA = await putBase(tokenA, {
      providerPlaceId: "ChIJ_iso_a",
      formattedAddress: "Base de A",
      latitude: -23.55,
      longitude: -46.63,
    });
    expect(putA.status).toBe(200);
    expect(putA.body.operationalBase.driverId).toBe(driverA.id);

    const getB = await getBase(tokenB);
    expect(getB.status).toBe(200);
    expect(getB.body.operationalBase).toBeNull();

    const countA = await prisma.driverOperationalBase.count({
      where: { driverId: driverA.id },
    });
    const countB = await prisma.driverOperationalBase.count({
      where: { driverId: driverB.id },
    });
    expect(countA).toBe(1);
    expect(countB).toBe(0);
  });

  it("422 quando providerPlaceId está ausente (texto digitado à mão não vale)", async () => {
    const email = `opb.noprovider.${tag()}@test.com`;
    await createDriverUser(email);
    const token = await login(email);

    const res = await putBase(token, {
      formattedAddress: "Rua digitada manualmente",
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("BASE_NOT_RESOLVABLE");
  });

  it("400 quando o corpo não é um objeto", async () => {
    const email = `opb.badbody.${tag()}@test.com`;
    await createDriverUser(email);
    const token = await login(email);

    const res = await putBase(token, "string inválida" as never);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_BODY");
  });
});

describe("PUT /drivers/me/operational-base — coordenadas nunca são fabricadas nem spoofadas", () => {
  it("lat/lng fora de faixa ou (0,0) → 422 BASE_NOT_RESOLVABLE e NADA é persistido", async () => {
    const email = `opb.trust.${tag()}@test.com`;
    const { driver } = await createDriverUser(email);
    const token = await login(email);

    // latitude fora de [-90,90] e longitude fora de [-180,180]: o handler
    // sanitiza como ausentes; sem chave do Google não há geometria autoritativa
    // → 422, jamais persistir (0,0) (que inflava M→A para milhares de km).
    const res = await putBase(token, {
      providerPlaceId: "ChIJ_spoof_001",
      formattedAddress: "Endereço confiável",
      latitude: -99.99,
      longitude: 412.12,
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("BASE_NOT_RESOLVABLE");

    const stored = await prisma.driverOperationalBase.findUnique({
      where: { driverId: driver.id },
    });
    expect(stored).toBeNull();
  });

  it("providerPlaceId sem coordenadas e sem chave do Google → 422 (nunca grava 0/0)", async () => {
    const email = `opb.nocoords.${tag()}@test.com`;
    const { driver } = await createDriverUser(email);
    const token = await login(email);

    const res = await putBase(token, {
      providerPlaceId: "ChIJ_sem_geometria",
      formattedAddress: "Endereço sem geometria",
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("BASE_NOT_RESOLVABLE");

    const stored = await prisma.driverOperationalBase.findUnique({
      where: { driverId: driver.id },
    });
    expect(stored).toBeNull();
  });

  it("uma base válida anterior não é corrompida por um PUT com lat/lng fora de faixa", async () => {
    const email = `opb.spoof.overwrite.${tag()}@test.com`;
    const { driver } = await createDriverUser(email);
    const token = await login(email);

    const first = await putBase(token, {
      providerPlaceId: "ChIJ_original",
      formattedAddress: "Base original",
      latitude: -23.55,
      longitude: -46.63,
    });
    expect(first.status).toBe(200);
    expect(first.body.operationalBase.latitude).toBe(-23.55);

    const second = await putBase(token, {
      providerPlaceId: "ChIJ_original",
      formattedAddress: "Base atualizada",
      latitude: -99.99,
      longitude: 412.12,
    });

    expect(second.status).toBe(422);
    expect(second.body.code).toBe("BASE_NOT_RESOLVABLE");

    const stored = await prisma.driverOperationalBase.findUniqueOrThrow({
      where: { driverId: driver.id },
    });
    expect(stored.latitude).toBe(-23.55);
    expect(stored.longitude).toBe(-46.63);
    expect(stored.formattedAddress).toBe("Base original");
  });
});

describe("Regressão Fase E — motorista legado sem base → 422 → PUT base → quote M→A", () => {
  it("SCHEDULED sem base nem posição → 422 QUOTE_UNAVAILABLE; após PUT base → 201 REGISTERED_BASE", async () => {
    const email = `opb.legacy.${tag()}@test.com`;
    const { driver: m1 } = await createDriverUser(email);
    const token = await login(email);

    // Passageiro referido pelo M1 (referência válida para o pricing M→A).
    const passengerUser = await prisma.user.create({
      data: {
        name: "Pax OBP Regressão",
        email: `opb.pax.${tag()}@test.com`,
        phone: "1192222000",
        role: "PASSENGER" as const,
      },
    });
    const passenger = await prisma.passenger.create({
      data: {
        userId: passengerUser.id,
        referralCode: `opb-psg-${tag()}`,
        publicSlug: `opb-psg-${tag()}`,
        referredByDriverId: m1.id,
      },
    });

    const body = {
      passengerId: passenger.id,
      origin: "Zona Norte",
      destination: "Centro",
      scheduledAt: new Date(Date.now() + 90_000_000).toISOString(),
      originLat: -23.55,
      originLng: -46.63,
      destinationLat: -23.9,
      destinationLng: -46.65,
    };

    // Sem base operacional e sem posição corrente: SCHEDULED não resolve a
    // origem M → 422 QUOTE_UNAVAILABLE, sem corrida criada e sem fallback.
    const before = await request(app).post("/rides").send(body);
    expect(before.status).toBe(422);
    expect(before.body.code).toBe("QUOTE_UNAVAILABLE");

    const ridesBefore = await prisma.rideRequest.findMany({
      where: { passengerId: passenger.id },
    });
    expect(ridesBefore).toHaveLength(0);

    // Self-service: o próprio motorista configura a base operacional com o
    // seletor do Google + coordenadas obtidas da geocodificação (em dev sem
    // chave, o pass-through aceita coordenadas dentro dos limites físicos).
    const put = await putBase(token, {
      providerPlaceId: "ChIJ_legacy_base",
      formattedAddress: "Base Centro",
      latitude: -23.55,
      longitude: -46.63,
    });
    expect(put.status).toBe(200);
    const storedBase = await prisma.driverOperationalBase.findUniqueOrThrow({
      where: { driverId: m1.id },
    });
    expect(storedBase.providerPlaceId).toBe("ChIJ_legacy_base");
    expect(storedBase.latitude).toBe(-23.55);
    expect(storedBase.longitude).toBe(-46.63);

    // Mesma corrida agora emite quote QUOTED com origem M = REGISTERED_BASE.
    const after = await request(app).post("/rides").send(body);
    expect(after.status).toBe(201);
    expect(after.body.rideQuote).toBeTruthy();
    expect(after.body.rideQuote.status).toBe("QUOTED");
    expect(after.body.rideQuote.originMSource).toBe("REGISTERED_BASE");

    const quote = await prisma.rideQuote.findUniqueOrThrow({
      where: { id: after.body.rideQuote.id },
    });
    expect(quote.pricingDriverId).toBe(m1.id);
    expect(quote.status).toBe("QUOTED");
    expect(quote.originMSource).toBe("REGISTERED_BASE");
    expect(quote.grossFinalCents).toBe(
      quote.legCostMtoACents + quote.legPriceAtoBCents,
    );
    // Sanidade de preço: base com coordenadas reais → perna M→A curta, quote
    // em dezenas de reais (nunca milhares — regressão da base (0,0)).
    expect(quote.legCostMtoACents).toBeLessThan(10_000);
    expect(quote.grossFinalCents).toBeLessThan(200_000);
    expect(after.body.ride.priceEstimated).toBe(quote.grossFinalCents / 100);

    // Confirmação AGREED + primeira oferta (M1) — pipeline intacto pós-base.
    const confirm = await request(app)
      .post(`/rides/${after.body.ride.id}/confirm-quote`)
      .send();
    expect(confirm.status).toBe(200);

    const offer = await prisma.rideOffer.findFirstOrThrow({
      where: { rideRequestId: after.body.ride.id },
    });
    expect(offer.driverId).toBe(m1.id);

    await matchingJobScheduler.drain();
  });
});