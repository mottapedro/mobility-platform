import request from "supertest";
import { app } from "../src/app";
import { prisma } from "./setup";

describe("PATCH /offers/respond", () => {
  it("deve aceitar uma offer", async () => {
    const driver = await prisma.user.create({
      data: {
        name: "Driver",
        email: "driver@test.com",
        phone: "999",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "PROFISSIONAL",
            isActive: true,
          },
        },
      },
      include: { driver: true },
    });

    const passenger = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name: "Passageiro",
            email: "p@test.com",
            phone: "111",
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
        scheduledAt: new Date(),
        status: "WAITING_DRIVER",
      },
    });

    const offer = await prisma.rideOffer.create({
      data: {
        rideRequestId: ride.id,
        driverId: driver.driver!.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 100000),
      },
    });

    const res = await request(app)
      .patch(`/offers/${offer.id}/respond`)
      .send({ accept: true });

    expect(res.status).toBe(200);

    const updatedRide = await prisma.rideRequest.findUnique({
      where: { id: ride.id },
    });

    expect(updatedRide?.selectedDriverId).toBe(driver.driver!.id);
  });

  it("deve rejeitar uma offer", async () => {
    const driver = await prisma.user.create({
      data: {
        name: "Driver2",
        email: "driver2@test.com",
        phone: "999",
        role: "DRIVER",
        driver: {
          create: {
            experienceLevel: "PROFISSIONAL",
            isActive: true,
          },
        },
      },
      include: { driver: true },
    });

    const passenger = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name: "Passageiro2",
            email: "p2@test.com",
            phone: "111",
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
        scheduledAt: new Date(),
        status: "MATCHING",
      },
    });

    const offer = await prisma.rideOffer.create({
      data: {
        rideRequestId: ride.id,
        driverId: driver.driver!.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 100000),
      },
    });

    const res = await request(app)
      .patch(`/offers/${offer.id}/respond`)
      .send({ accept: false });

    expect(res.status).toBe(200);

    const updatedOffer = await prisma.rideOffer.findUnique({
      where: { id: offer.id },
    });

    expect(updatedOffer?.status).toBe("REJECTED");
  });
});

// ─── GET /drivers/:driverId/offers ─────────────────────────────────────────
describe("GET /drivers/:driverId/offers", () => {
  async function createDriverAndPassenger(suffix: string) {
    const driverUser = await prisma.user.create({
      data: {
        name: `Driver Offers ${suffix}`,
        email: `driveroffers${suffix}@offers.com`,
        phone: `770000${suffix}`,
        role: "DRIVER",
        driver: { create: { experienceLevel: "PROFISSIONAL", isActive: true } },
      },
      include: { driver: true },
    });

    const passenger = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name: `Pax ${suffix}`,
            email: `paxoffers${suffix}@offers.com`,
            phone: `780000${suffix}`,
            role: "PASSENGER",
          },
        },
      },
    });

    return { driverUser, passenger };
  }

  it("não deve retornar offers com expiresAt no passado", async () => {
    const { driverUser, passenger } = await createDriverAndPassenger("exp");

    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "A",
        destination: "B",
        scheduledAt: new Date(Date.now() + 3_600_000),
        status: "MATCHING",
      },
    });

    await prisma.rideOffer.create({
      data: {
        rideRequestId: ride.id,
        driverId: driverUser.driver!.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() - 1000), // expirou
      },
    });

    const res = await request(app).get(`/drivers/${driverUser.driver!.id}/offers`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("deve retornar offer de corrida em WAITING_REFERRAL (driver indicado)", async () => {
    const { driverUser, passenger: _ } = await createDriverAndPassenger("ref");

    // Recriar passageiro com referral apontando para o driver criado
    const passengerRef = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name: "Pax Ref",
            email: "paxref@offers.com",
            phone: "79000000001",
            role: "PASSENGER",
          },
        },
        referredByDriver: { connect: { id: driverUser.driver!.id } },
      },
    });

    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passengerRef.id,
        origin: "A",
        destination: "B",
        scheduledAt: new Date(Date.now() + 3_600_000),
        status: "WAITING_REFERRAL",
      },
    });

    await prisma.rideOffer.create({
      data: {
        rideRequestId: ride.id,
        driverId: driverUser.driver!.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 300_000),
      },
    });

    const res = await request(app).get(`/drivers/${driverUser.driver!.id}/offers`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].rideRequest.status).toBe("WAITING_REFERRAL");
  });

  it("não deve retornar offers de corridas ACCEPTED", async () => {
    const { driverUser, passenger } = await createDriverAndPassenger("acc");

    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "A",
        destination: "B",
        scheduledAt: new Date(Date.now() + 3_600_000),
        status: "ACCEPTED",
        selectedDriverId: driverUser.driver!.id,
      },
    });

    await prisma.rideOffer.create({
      data: {
        rideRequestId: ride.id,
        driverId: driverUser.driver!.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 300_000),
      },
    });

    const res = await request(app).get(`/drivers/${driverUser.driver!.id}/offers`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("deve retornar 404 para driverId inexistente", async () => {
    const res = await request(app).get(
      "/drivers/00000000-0000-0000-0000-000000000000/offers"
    );
    expect(res.status).toBe(404);
  });
});

// ─── Fluxo completo: aceitar offer ─────────────────────────────────────────
describe("Aceitar offer — fluxo completo", () => {
  it("após aceitar offer, corrida aparece em /rides e some de /offers", async () => {
    const driverUser = await prisma.user.create({
      data: {
        name: "Driver Full",
        email: "driverfull@offers.com",
        phone: "66000000001",
        role: "DRIVER",
        driver: { create: { experienceLevel: "PROFISSIONAL", isActive: true } },
      },
      include: { driver: true },
    });

    const passenger = await prisma.passenger.create({
      data: {
        user: {
          create: {
            name: "Pax Full",
            email: "paxfull@offers.com",
            phone: "66000000002",
            role: "PASSENGER",
          },
        },
      },
    });

    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "Barra",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 3_600_000),
        status: "WAITING_DRIVER",
      },
    });

    const offer = await prisma.rideOffer.create({
      data: {
        rideRequestId: ride.id,
        driverId: driverUser.driver!.id,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 100_000),
      },
    });

    // Aceitar offer
    const respondRes = await request(app)
      .patch(`/offers/${offer.id}/respond`)
      .send({ accept: true });

    expect(respondRes.status).toBe(200);

    // /offers deve estar vazio (corrida ACCEPTED é filtrada pelo endpoint)
    const offersRes = await request(app).get(
      `/drivers/${driverUser.driver!.id}/offers`
    );
    expect(offersRes.status).toBe(200);
    expect(offersRes.body).toHaveLength(0);

    // /rides deve conter a corrida confirmada
    const ridesRes = await request(app).get(
      `/drivers/${driverUser.driver!.id}/rides`
    );
    expect(ridesRes.status).toBe(200);
    expect(ridesRes.body).toHaveLength(1);
    expect(ridesRes.body[0].id).toBe(ride.id);
    expect(ridesRes.body[0].status).toBe("ACCEPTED");
  });
});
