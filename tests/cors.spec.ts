import bcrypt from "bcrypt";
import request from "supertest";

import { app } from "../src/app";
import { prisma } from "./setup";

describe("Global CORS", () => {
  it("returns CORS headers on GET /drivers/:id/offers for localhost", async () => {
    const origin = "http://localhost:3001";

    const user = await prisma.user.create({
      data: {
        name: "CORS Driver",
        email: "cors-driver@test.com",
        phone: "11999990001",
        role: "DRIVER",
      },
    });

    const driver = await prisma.driver.create({
      data: {
        userId: user.id,
        isActive: true,
        experienceLevel: "PROFISSIONAL",
      },
    });

    const passenger = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name: "CORS Passenger",
            email: "cors-passenger@test.com",
            phone: "11999990002",
            role: "PASSENGER",
          },
        },
      },
    });

    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "A",
        destination: "B",
        scheduledAt: new Date(Date.now() + 60_000),
        status: "WAITING_DRIVER",
      },
    });

    await prisma.rideOffer.create({
      data: {
        rideRequestId: ride.id,
        driverId: driver.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const response = await request(app)
      .get(`/drivers/${driver.id}/offers`)
      .set("Origin", origin);

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("returns CORS headers on GET /offers for Vercel preview deploys", async () => {
    const origin = "https://mobility-platform-git-feature-branch-mottapedro.vercel.app";

    const response = await request(app)
      .get("/offers")
      .set("Origin", origin);

    expect(response.status).toBe(404);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("returns CORS headers on POST /auth/login", async () => {
    const origin = "http://localhost:3000";
    const password = "123456";
    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name: "Login Driver",
        email: "cors-login@test.com",
        phone: "11999990003",
        role: "DRIVER",
        passwordHash,
      },
    });

    await prisma.driver.create({
      data: {
        userId: user.id,
        isActive: true,
        experienceLevel: "INTERMEDIARIO",
      },
    });

    const response = await request(app)
      .post("/auth/login")
      .set("Origin", origin)
      .send({ email: "cors-login@test.com", password });

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("returns CORS headers on POST /auth/register for Vercel production deploys", async () => {
    const origin = "https://mobility-platform.vercel.app";

    const response = await request(app)
      .post("/auth/register")
      .set("Origin", origin)
      .send({
        name: "Register Passenger",
        email: "cors-register@test.com",
        password: "123456",
        role: "passenger",
        phone: "11999990004",
      });

    expect(response.status).toBe(201);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });
});