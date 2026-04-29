import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";

jest.setTimeout(15000);

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

// ─── PATCH /rides/:id — reject_referral ───────────────────────────────────
describe("PATCH /rides/:id — reject_referral", () => {
  async function setup() {
    const driverUser = await prisma.user.create({
      data: {
        name: "Driver Ref",
        email: "driverref@rides.com",
        phone: "99000000001",
        role: "DRIVER",
        driver: { create: { experienceLevel: "PROFISSIONAL", isActive: true } },
      },
      include: { driver: true },
    });

    const passenger = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name: "Passageiro",
            email: "paxrj@rides.com",
            phone: "99000000002",
            role: "PASSENGER",
          },
        },
        referredByDriver: { connect: { id: driverUser.driver!.id } },
      },
    });

    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "A",
        destination: "B",
        scheduledAt: new Date(Date.now() + 3_600_000),
        status: "WAITING_REFERRAL",
      },
    });

    const offer = await prisma.rideOffer.create({
      data: {
        rideRequestId: ride.id,
        driverId: driverUser.driver!.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 300_000),
      },
    });

    return { driverUser, ride, offer };
  }

  it("deve retornar 200 e expirar a offer do driver indicado", async () => {
    const { ride, offer } = await setup();

    const res = await request(app)
      .patch(`/rides/${ride.id}`)
      .send({ action: "reject_referral" });

    expect(res.status).toBe(200);

    const updatedOffer = await prisma.rideOffer.findUnique({ where: { id: offer.id } });
    expect(updatedOffer?.status).toBe("EXPIRED");
  });

  it("deve mover corrida para fora do estado WAITING_REFERRAL", async () => {
    const { ride } = await setup();

    await request(app).patch(`/rides/${ride.id}`).send({ action: "reject_referral" });

    const updatedRide = await prisma.rideRequest.findUnique({ where: { id: ride.id } });
    // Pode ser MATCHING (se sem drivers disponíveis) ou WAITING_DRIVER/EXPIRED após matching
    expect(updatedRide?.status).not.toBe("WAITING_REFERRAL");
  });

  it("deve retornar 409 quando corrida não está em WAITING_REFERRAL", async () => {
    const passenger = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name: "Pax",
            email: "pax409@rides.com",
            phone: "99000000003",
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
        scheduledAt: new Date(Date.now() + 3_600_000),
        status: "MATCHING",
      },
    });

    const res = await request(app)
      .patch(`/rides/${ride.id}`)
      .send({ action: "reject_referral" });

    expect(res.status).toBe(409);
  });

  it("deve retornar 404 para corrida inexistente", async () => {
    const res = await request(app)
      .patch("/rides/00000000-0000-0000-0000-000000000000")
      .send({ action: "reject_referral" });

    expect(res.status).toBe(404);
  });

  it("deve retornar 400 para action inválida", async () => {
    const { ride } = await setup();

    const res = await request(app)
      .patch(`/rides/${ride.id}`)
      .send({ action: "aceitar_tudo" });

    expect(res.status).toBe(400);
  });
});

// ─── GET /drivers/:driverId/rides ─────────────────────────────────────────
describe("GET /drivers/:driverId/rides", () => {
  it("deve retornar somente corridas ACCEPTED com selectedDriverId do driver", async () => {
    const driverUser = await prisma.user.create({
      data: {
        name: "Driver Rides",
        email: "driverrides@rides.com",
        phone: "88000000001",
        role: "DRIVER",
        driver: { create: { experienceLevel: "PROFISSIONAL", isActive: true } },
      },
      include: { driver: true },
    });

    const passenger = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name: "Pax Rides",
            email: "paxrides@rides.com",
            phone: "88000000002",
            role: "PASSENGER",
          },
        },
      },
    });

    // Corrida ACCEPTED com selectedDriverId — deve aparecer
    const accepted = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "Barra",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 3_600_000),
        status: "ACCEPTED",
        selectedDriverId: driverUser.driver!.id,
      },
    });

    // Corrida MATCHING sem selectedDriverId — NÃO deve aparecer
    await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "C",
        destination: "D",
        scheduledAt: new Date(Date.now() + 7_200_000),
        status: "MATCHING",
      },
    });

    const res = await request(app).get(`/drivers/${driverUser.driver!.id}/rides`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(accepted.id);
    expect(res.body[0].passenger.user.name).toBe("Pax Rides");
  });

  it("deve retornar array vazio quando driver não tem corridas confirmadas", async () => {
    const driverUser = await prisma.user.create({
      data: {
        name: "Driver Vazio",
        email: "drivervazio@rides.com",
        phone: "88000000003",
        role: "DRIVER",
        driver: { create: { experienceLevel: "INICIANTE", isActive: true } },
      },
      include: { driver: true },
    });

    const res = await request(app).get(`/drivers/${driverUser.driver!.id}/rides`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("deve retornar 404 para driverId inexistente", async () => {
    const res = await request(app).get(
      "/drivers/00000000-0000-0000-0000-000000000000/rides"
    );
    expect(res.status).toBe(404);
  });
});
