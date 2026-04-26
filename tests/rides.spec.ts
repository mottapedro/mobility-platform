import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";

describe("POST /rides", () => {
  it("deve criar uma corrida e disparar matching", async () => {
    const passenger = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name: "Teste",
            email: "teste@test.com",
            phone: "999999999",
            role: "PASSENGER",
          },
        },
      },
    });

    const response = await request(app)
      .post("/rides")
      .send({
        passengerId: passenger.id,
        origin: "Barra",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        context: {
          vip: true,
          airport: false,
          pet: false,
          luggage: false,
        },
      });

    expect(response.status).toBe(201);

    const ride = await prisma.rideRequest.findFirst({
      include: { offers: true },
    });

    expect(ride).toBeTruthy();
    expect(ride?.status).toBeDefined();
  });
});
