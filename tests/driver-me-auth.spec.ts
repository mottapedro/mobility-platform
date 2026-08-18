import request from "supertest";
import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { app } from "../src/app";
import { prisma } from "./setup";
import { AuthTokenService } from "../src/domain/auth/AuthTokenService";
import { AuthSessionService } from "../src/domain/auth/AuthSessionService";
import { loadAuthConfig } from "../src/config/auth";

const TEST_EMAIL = "bearer.me@auth.com";
const TEST_PASSWORD = "123456";
const DENIED_ERROR = "Driver authentication required";

async function createDriverUser(email: string) {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const user = await prisma.user.create({
    data: {
      name: "Bearer Driver",
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

async function createInactiveDriverUser(email: string) {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const user = await prisma.user.create({
    data: {
      name: "Inactive Bearer Driver",
      email,
      phone: "11998887788",
      role: "DRIVER",
      passwordHash,
    },
  });
  const driver = await prisma.driver.create({
    data: {
      userId: user.id,
      isActive: false,
      experienceLevel: "INTERMEDIARIO",
      regions: ["ZN"],
    },
  });
  return { user, driver };
}

async function login(email: string) {
  return request(app).post("/auth/login").send({ email, password: TEST_PASSWORD });
}

async function getMeWith(token: string) {
  return request(app).get("/drivers/me").set("Authorization", `Bearer ${token}`);
}

describe("Fase C — Bearer auth em /drivers/me", () => {
  it("emite accessToken e refreshToken no login", async () => {
    await createDriverUser(TEST_EMAIL);

    const res = await login(TEST_EMAIL);

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe("string");
    expect(res.body.accessToken.length).toBeGreaterThan(40);
    expect(typeof res.body.refreshToken).toBe("string");
    expect(res.body.session.id).toBeDefined();

    const verified = await new AuthTokenService().verifyAccessToken(res.body.accessToken);
    expect(verified.sub).toBe(res.body.user.id);
    expect(verified.sid).toBe(res.body.session.id);
  });

  it("GET /drivers/me retorna o perfil com Bearer válido", async () => {
    const { user, driver } = await createDriverUser("bearer.me.profile@auth.com");
    const login = await request(app).post("/auth/login").send({
      email: "bearer.me.profile@auth.com",
      password: TEST_PASSWORD,
    });

    const res = await request(app)
      .get("/drivers/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.driverId).toBe(driver.id);
    expect(res.body.email).toBe(user.email);
    expect(res.body.regions).toContain("ZN");
  });

  it("GET /drivers/me rejeita request sem token", async () => {
    await createDriverUser("bearer.me.none@auth.com");

    const res = await request(app).get("/drivers/me");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("GET /drivers/me rejeita token inválido", async () => {
    await createDriverUser("bearer.me.garbage@auth.com");

    const res = await request(app)
      .get("/drivers/me")
      .set("Authorization", "Bearer not-a-real-token");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("GET /drivers/me ignora x-driver-id sem Bearer", async () => {
    const { driver } = await createDriverUser("bearer.me.xid@auth.com");

    const res = await request(app)
      .get("/drivers/me")
      .set("x-driver-id", driver.id);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("rejeita access token com sid inexistente", async () => {
    const { user } = await createDriverUser("bearer.me.nosid@auth.com");

    const accessToken = await new AuthTokenService().issueAccessToken({
      userId: user.id,
      sessionId: randomUUID(),
    });

    const res = await getMeWith(accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("rejeita access token cuja sessão foi revogada", async () => {
    const { user } = await createDriverUser("bearer.me.revoked@auth.com");
    const issued = await new AuthSessionService().createSession(user.id);

    await prisma.authSession.update({
      where: { id: issued.session.id },
      data: { revokedAt: new Date() },
    });

    const accessToken = await new AuthTokenService().issueAccessToken({
      userId: user.id,
      sessionId: issued.session.id,
    });

    const res = await getMeWith(accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("rejeita access token cuja sessão expirou", async () => {
    const { user } = await createDriverUser("bearer.me.expired@auth.com");
    const issued = await new AuthSessionService().createSession(user.id);

    await prisma.authSession.update({
      where: { id: issued.session.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const accessToken = await new AuthTokenService().issueAccessToken({
      userId: user.id,
      sessionId: issued.session.id,
    });

    const res = await getMeWith(accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("rejeita access token cuja sessão pertence a outro userId", async () => {
    const { user: ownerUser } = await createDriverUser("bearer.me.owner@auth.com");
    const { user: otherUser } = await createDriverUser("bearer.me.other@auth.com");

    const issued = await new AuthSessionService().createSession(ownerUser.id);

    const accessToken = await new AuthTokenService().issueAccessToken({
      userId: otherUser.id,
      sessionId: issued.session.id,
    });

    const res = await getMeWith(accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("rejeita access token expirado", async () => {
    const { user } = await createDriverUser("bearer.me.jwtexpired@auth.com");
    const issued = await new AuthSessionService().createSession(user.id);

    const past = new Date(Date.now() - 3_600_000);
    const expiredTokenService = new AuthTokenService(loadAuthConfig(), () => past);
    const expiredToken = await expiredTokenService.issueAccessToken({
      userId: user.id,
      sessionId: issued.session.id,
    });

    const res = await getMeWith(expiredToken);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("rejeita usuário sem Driver ativo", async () => {
    const { user } = await createInactiveDriverUser("bearer.me.inactive@auth.com");
    const issued = await new AuthSessionService().createSession(user.id);

    const accessToken = await new AuthTokenService().issueAccessToken({
      userId: user.id,
      sessionId: issued.session.id,
    });

    const res = await getMeWith(accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(DENIED_ERROR);
  });

  it("GET /drivers/me/offers e /drivers/me/rides respondem 200 com Bearer válido", async () => {
    await createDriverUser("bearer.me.lists@auth.com");
    const login = await request(app).post("/auth/login").send({
      email: "bearer.me.lists@auth.com",
      password: TEST_PASSWORD,
    });

    const offers = await request(app)
      .get("/drivers/me/offers")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(offers.status).toBe(200);
    expect(Array.isArray(offers.body)).toBe(true);

    const rides = await request(app)
      .get("/drivers/me/rides")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(rides.status).toBe(200);
    expect(Array.isArray(rides.body)).toBe(true);
  });
});