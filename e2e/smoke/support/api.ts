import bcrypt from "bcrypt";
import request from "supertest";
import { RideStatus } from "../../../src/shared/enums";
import { app } from "../../../src/app";
import { prisma } from "../../../tests/setup";

// ── Default Rio de Janeiro coordinates (~3.5 km apart, triggers PricingEngine) ──
const ORIGIN_LAT      = -22.9068;
const ORIGIN_LNG      = -43.1729;
const DESTINATION_LAT = -22.8833;
const DESTINATION_LNG = -43.1072;

// ── Actor helpers (direct Prisma — avoids auth complexity) ───────────────────

export async function makeDriver(email: string) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
      phone: `21${Math.floor(1e9 + Math.random() * 8e9)}`,
      role: "DRIVER",
      passwordHash: await bcrypt.hash("x", 4),
    },
  });
  return prisma.driver.create({
    data: { userId: u.id, isActive: true, experienceLevel: "INTERMEDIARIO", regions: ["ZN"] },
  });
}

export async function makePassenger(email: string, rootDriverId?: string | null) {
  const u = await prisma.user.create({
    data: {
      name: email,
      email,
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

// ── HTTP helpers (supertest against imported app) ────────────────────────────

interface RideQuote {
  baseFare: number;
  driverNetAmount: number;
  platformFee: number;
  totalPassengerPrice: number;
  distanceKm: number;
  estimatedDurationMin: number;
  pricingVersion: string;
  breakdown: Array<{ label: string; value: number }>;
}

interface CreateRideResponse {
  id: string;
  priceEstimated: number | null;
  quote: RideQuote | null;
}

interface CreateRideOpts {
  originLat?: number;
  originLng?: number;
  destinationLat?: number;
  destinationLng?: number;
}

/**
 * Creates a ride via HTTP POST /rides.
 * All four coordinate fields are required and included (lat/lng fix).
 * Returns the created ride id, priceEstimated, and RideQuote DTO.
 */
export async function createRide(
  passengerId: string,
  opts: CreateRideOpts = {},
): Promise<CreateRideResponse> {
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1 hour

  const res = await request(app)
    .post("/rides")
    .send({
      passengerId,
      origin:          "Lapa, Rio de Janeiro",
      destination:     "Maracanã, Rio de Janeiro",
      scheduledAt,
      originLat:      opts.originLat      ?? ORIGIN_LAT,
      originLng:      opts.originLng      ?? ORIGIN_LNG,
      destinationLat: opts.destinationLat ?? DESTINATION_LAT,
      destinationLng: opts.destinationLng ?? DESTINATION_LNG,
    });

  if (res.status !== 201) {
    throw new Error(
      `POST /rides failed ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }

  return {
    id:             res.body.ride.id as string,
    priceEstimated: res.body.ride.priceEstimated as number | null,
    quote:          res.body.quote as RideQuote | null,
  };
}

/** Advances a ride to COMPLETED so the payment flow can proceed. */
export async function setRideCompleted(rideId: string): Promise<void> {
  await prisma.rideRequest.update({
    where: { id: rideId },
    data:  { status: RideStatus.COMPLETED },
  });
}

export interface PaymentIntentResult {
  status: number;
  body: {
    success: boolean;
    rideId: string;
    intentId: string;
    externalId: string;
    totalPrice: number;
    amount: number;
    qrCode: string;
    breakdown: Array<{ label: string; value: number }>;
    code?: string;
    error?: string;
  };
}

export async function createPaymentIntent(rideId: string): Promise<PaymentIntentResult> {
  const res = await request(app)
    .post(`/rides/${rideId}/payment-intent`)
    .send({});
  return { status: res.status, body: res.body };
}

export async function triggerPixWebhook(externalId: string): Promise<{ status: number; body: unknown }> {
  const res = await request(app)
    .post("/webhooks/pix")
    .send({ externalId, status: "CONFIRMED" });
  return { status: res.status, body: res.body };
}

export async function getSettlement(rideId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request(app).get(`/rides/${rideId}/settlement`);
  return { status: res.status, body: res.body };
}
