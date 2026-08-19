// PUT /drivers/me/operational-base — contrato HTTP de validação server-side.
//
// Este arquivo MOCA o DriverOperationalBaseService para provar, na camada HTTP:
//   1) providerPlaceId que o Google não resolve → 422 (proibido 500);
//   2) erros de upstream/resposta inválida → 422, nunca 500;
//   3) lat/lng do cliente NUNCA chegam ao serviço (Decision B) — o handler só
//      repassa providerPlaceId + formattedAddress.
//
// O driver/controller faz o request normalmente (supertest); apenas o serviço
// é substituído para controle determinístico do caminho inválido, que no
// ambiente sem chave do Google degradaria para CLIENT_FALLBACK (válido).

/// <reference types="jest" />
import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../src/app";
import { prisma } from "./setup";
import { DriverOperationalBaseService } from "../src/domain/driver/DriverOperationalBaseService";

// `mock` prefix é explicitamente permitido dentro da factory do jest.mock.
const mockSave = jest.fn();

jest.mock("../src/domain/driver/DriverOperationalBaseService", () => ({
  DriverOperationalBaseService: jest.fn().mockImplementation(() => ({
    save: mockSave,
  })),
}));

const TEST_PASSWORD = "123456";

let seq = 0;
function tag() {
  seq += 1;
  return `${Date.now()}.${seq}`;
}

async function createDriverUser(email: string) {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const user = await prisma.user.create({
    data: {
      name: "Operational Base Mock Driver",
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

function putBase(token: string, body: Record<string, unknown>) {
  return request(app)
    .put("/drivers/me/operational-base")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

describe("PUT /drivers/me/operational-base — tratamento de provider/resposta inválida (nunca 500)", () => {
  beforeEach(async () => {
    mockSave.mockReset();
  });

  it("providerPlaceId não resolvido pelo Google → 422 PLACE_NOT_FOUND (não 500)", async () => {
    const email = `opb.mock.notfound.${tag()}@test.com`;
    const { driver } = await createDriverUser(email);
    const token = await login(email);

    mockSave.mockResolvedValueOnce({
      valid: false,
      providerPlaceId: "ChIJ_inexistente",
      address: null,
      reason: "Place not found: ChIJ_inexistente",
      code: "PLACE_NOT_FOUND",
    });

    const res = await putBase(token, {
      providerPlaceId: "ChIJ_inexistente",
      formattedAddress: "Endereço que não existe",
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PLACE_NOT_FOUND");
    expect(res.body.error).toMatch(/Place not found/);

    const stored = await prisma.driverOperationalBase.findUnique({
      where: { driverId: driver.id },
    });
    expect(stored).toBeNull();
  });

  it("resposta inválida do Google → 422 INVALID_RESPONSE (não 500)", async () => {
    const email = `opb.mock.invalidresp.${tag()}@test.com`;
    await createDriverUser(email);
    const token = await login(email);

    mockSave.mockResolvedValueOnce({
      valid: false,
      providerPlaceId: "ChIJ_x",
      address: null,
      reason: "Google Places returned an unexpected payload",
      code: "INVALID_RESPONSE",
    });

    const res = await putBase(token, {
      providerPlaceId: "ChIJ_x",
      formattedAddress: "Qualquer",
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("INVALID_RESPONSE");
  });

  it("lat/lng enviados pelo cliente nunca chegam ao serviço (Decision B)", async () => {
    const email = `opb.mock.notforward.${tag()}@test.com`;
    const { driver } = await createDriverUser(email);
    const token = await login(email);

    // O mock precisa persistir a linha para o re-read pós-save do controller.
    mockSave.mockImplementationOnce(async (driverId: string, input: { providerPlaceId: string; address: string | null }) => {
      await prisma.driverOperationalBase.upsert({
        where: { driverId },
        update: {
          formattedAddress: input.address ?? "Base operacional",
          providerPlaceId: input.providerPlaceId,
          latitude: 0,
          longitude: 0,
        },
        create: {
          driverId,
          formattedAddress: input.address ?? "Base operacional",
          providerPlaceId: input.providerPlaceId,
          latitude: 0,
          longitude: 0,
        },
      });
      return {
        valid: true,
        providerPlaceId: input.providerPlaceId,
        address: input.address ?? null,
        lat: 0,
        lng: 0,
        source: "GOOGLE_PLACE_DETAILS",
      };
    });

    const res = await putBase(token, {
      providerPlaceId: "ChIJ_ok",
      formattedAddress: "Av. Paulista, 1000",
      latitude: -99.99,
      longitude: 412.12,
    });

    expect(res.status).toBe(200);
    expect(res.body.operationalBase.providerPlaceId).toBe("ChIJ_ok");

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith(driver.id, {
      providerPlaceId: "ChIJ_ok",
      address: "Av. Paulista, 1000",
    });
    const forwarded = mockSave.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("latitude");
    expect(forwarded).not.toHaveProperty("longitude");
  });
});