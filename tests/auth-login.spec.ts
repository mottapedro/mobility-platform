import request from "supertest";
import bcrypt from "bcrypt";
import { app } from "../src/app";
import { prisma } from "./setup";

const TEST_EMAIL = "testdriver@auth.com";
const TEST_PASSWORD = "123456";

beforeEach(async () => {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const user = await prisma.user.create({
    data: {
      name: "Test Driver",
      email: TEST_EMAIL,
      phone: "11999990000",
      role: "DRIVER",
      passwordHash,
    },
  });
  if (user?.id) {
    await prisma.driver.create({
      data: {
        userId: user.id,
        isActive: true,
        experienceLevel: "INTERMEDIARIO",
        regions: ["ZN"],
      },
    });
  }
});

describe("POST /auth/login", () => {
  it("✅ returns 200 with driverId on valid credentials", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(TEST_EMAIL);
    expect(res.body.driverId).toBeDefined();
    expect(res.body.referralCode).toBeDefined();
  });

  it("❌ returns 401 on wrong password", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email: TEST_EMAIL, password: "wrongpass" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it("❌ returns 400 when fields are missing", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email: TEST_EMAIL });

    expect(res.status).toBe(400);
  });

  it("❌ returns 400 when body is empty", async () => {
    const res = await request(app).post("/auth/login").send({});
    expect(res.status).toBe(400);
  });
});

describe("GET /auth/login", () => {
  it("❌ returns 405 Method Not Allowed", async () => {
    const res = await request(app).get("/auth/login");
    expect(res.status).toBe(405);
    expect(res.body.error).toBe("Method Not Allowed");
    expect(res.body.message).toContain("POST");
  });
});
