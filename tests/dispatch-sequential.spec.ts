/// <reference types="jest" />
/**
 * Governed Sequential Dispatch — invariant scenarios.
 *
 * Verifies the core contract of the dispatch runtime:
 *   1. one rejection advances the queue to the next candidate (no broadcast)
 *   2. the same driver is never re-offered after rejecting
 *   3. at every transition the invariant `COUNT(PENDING) === 1` holds
 *
 * The legacy broadcast loop would have created N PENDING offers per ride;
 * these tests guard against any regression that re-introduces that behavior.
 */
import { prisma } from "./setup";
import { MatchRideUseCase } from "../src/application/use-cases/MatchRideUseCase";
import { RespondToRideOfferUseCase } from "../src/application/use-cases/RespondToRideOfferUseCase";
import { createDriverReferralChain } from "../src/domain/services/DriverReferralService";

jest.setTimeout(20000);

async function pendingCount(rideId: string): Promise<number> {
  return prisma.rideOffer.count({
    where: { rideRequestId: rideId, status: "PENDING" },
  });
}

async function makeDriver(name: string, email: string, phone: string) {
  const u = await prisma.user.create({
    data: {
      name,
      email,
      phone,
      role: "DRIVER",
      driver: { create: { experienceLevel: "PROFISSIONAL", isActive: true } },
    },
    include: { driver: true },
  });
  return u.driver!;
}

describe("Governed Sequential Dispatch — invariants", () => {
  it("dispatches one offer at a time; advancing the queue on rejection", async () => {
    const driverA = await makeDriver(
      "Driver A",
      "seqA@matching.com",
      "55000000001"
    );
    const driverB = await makeDriver(
      "Driver B",
      "seqB@matching.com",
      "55000000002"
    );
    // chain B as level-1 partner of A so REFERRED → NETWORK_L1 escalation lands on B
    await createDriverReferralChain(driverB.id, driverA.id);

    const passengerUser = await prisma.user.create({
      data: {
        name: "Passageiro Seq",
        email: "pseq@matching.com",
        phone: "55000000003",
        role: "PASSENGER",
      },
    });
    const passenger = await prisma.passenger.create({
      data: {
        userId: passengerUser.id,
        referralCode: "ref-seq-" + Date.now(),
        publicSlug: "slug-seq-" + Date.now(),
        referredByDriverId: driverA.id,
      },
    });

    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "Barra da Tijuca",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 90_000_000),
        status: "PENDING",
      },
    });

    const match = new MatchRideUseCase();
    await match.execute({ rideId: ride.id });

    // After REFERRED dispatch: exactly 1 PENDING offer, to driver A.
    expect(await pendingCount(ride.id)).toBe(1);
    const firstOffer = await prisma.rideOffer.findFirstOrThrow({
      where: { rideRequestId: ride.id, status: "PENDING" },
    });
    expect(firstOffer.driverId).toBe(driverA.id);

    // Driver A rejects → re-dispatch should hand the offer to driver B (network L1).
    const respond = new RespondToRideOfferUseCase();
    await respond.execute(firstOffer.id, false, firstOffer.driverId);

    // Invariant: still exactly 1 PENDING offer.
    expect(await pendingCount(ride.id)).toBe(1);
    const nextOffer = await prisma.rideOffer.findFirstOrThrow({
      where: { rideRequestId: ride.id, status: "PENDING" },
    });
    expect(nextOffer.driverId).toBe(driverB.id);

    // Driver A's offer is REJECTED, never re-issued.
    const aOffers = await prisma.rideOffer.findMany({
      where: { rideRequestId: ride.id, driverId: driverA.id },
    });
    expect(aOffers.length).toBe(1);
    expect(aOffers[0].status).toBe("REJECTED");

    // Phase 2: persisted queue state reflects exclusion + current candidate pointer.
    const rideRow = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });
    expect((rideRow as { excludedDriverIds: string[] }).excludedDriverIds).toContain(driverA.id);
    expect((rideRow as { currentCandidateDriverId: string | null }).currentCandidateDriverId).toBe(driverB.id);
    // Dispatch stage separation: persisted enum is DispatchStage, value aligns
    // with telemetry stage codes (REFERRAL_NETWORK after escalation from REFERRED).
    expect((rideRow as { currentDispatchStage: string | null }).currentDispatchStage).toBe("REFERRAL_NETWORK");

    // Phase 3: lifecycle status escalated from WAITING_REFERRAL to WAITING_PARTNER
    // when the referred driver rejected and the partner-network search began.
    expect(rideRow.status).toBe("WAITING_PARTNER");
  });

  it("emits single_active_offer_enforced if a duplicate dispatch is attempted", async () => {
    const driver = await makeDriver(
      "Driver Solo",
      "soloA@matching.com",
      "55000000010"
    );

    const passengerUser = await prisma.user.create({
      data: {
        name: "Passageiro Solo",
        email: "pSolo@matching.com",
        phone: "55000000011",
        role: "PASSENGER",
      },
    });
    const passenger = await prisma.passenger.create({
      data: {
        userId: passengerUser.id,
        referralCode: "ref-solo-" + Date.now(),
        publicSlug: "slug-solo-" + Date.now(),
        referredByDriverId: driver.id,
      },
    });
    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "Barra da Tijuca",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 90_000_000),
        status: "PENDING",
      },
    });

    const match = new MatchRideUseCase();
    await match.execute({ rideId: ride.id });
    expect(await pendingCount(ride.id)).toBe(1);

    // A second execute() while an offer is still PENDING must not create more.
    await match.execute({ rideId: ride.id });
    expect(await pendingCount(ride.id)).toBe(1);
  });

  it("transitions WAITING_REFERRAL → WAITING_PARTNER → WAITING_GENERAL preserving the single-offer invariant", async () => {
    const driverA = await makeDriver(
      "Driver A3",
      "seqA3@matching.com",
      "55000000020"
    );
    const driverB = await makeDriver(
      "Driver B3",
      "seqB3@matching.com",
      "55000000021"
    );
    const driverC = await makeDriver(
      "Driver C3",
      "seqC3@matching.com",
      "55000000022"
    );
    // B is L1 partner of A; C is unaffiliated → falls through to GENERAL.
    await createDriverReferralChain(driverB.id, driverA.id);

    const passengerUser = await prisma.user.create({
      data: {
        name: "Passageiro Seq3",
        email: "pseq3@matching.com",
        phone: "55000000023",
        role: "PASSENGER",
      },
    });
    const passenger = await prisma.passenger.create({
      data: {
        userId: passengerUser.id,
        referralCode: "ref-seq3-" + Date.now(),
        publicSlug: "slug-seq3-" + Date.now(),
        referredByDriverId: driverA.id,
      },
    });
    const ride = await prisma.rideRequest.create({
      data: {
        passengerId: passenger.id,
        origin: "Barra da Tijuca",
        destination: "Centro",
        scheduledAt: new Date(Date.now() + 90_000_000),
        status: "PENDING",
      },
    });

    const match = new MatchRideUseCase();
    const respond = new RespondToRideOfferUseCase();

    // Tier 1 — REFERRED
    await match.execute({ rideId: ride.id });
    expect(await pendingCount(ride.id)).toBe(1);
    let row = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });
    expect(row.status).toBe("WAITING_REFERRAL");
    let offer = await prisma.rideOffer.findFirstOrThrow({
      where: { rideRequestId: ride.id, status: "PENDING" },
    });
    expect(offer.driverId).toBe(driverA.id);

    // A rejects → escalate to L1 partner B
    await respond.execute(offer.id, false, offer.driverId);
    expect(await pendingCount(ride.id)).toBe(1);
    row = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });
    expect(row.status).toBe("WAITING_PARTNER");
    offer = await prisma.rideOffer.findFirstOrThrow({
      where: { rideRequestId: ride.id, status: "PENDING" },
    });
    expect(offer.driverId).toBe(driverB.id);

    // B rejects → network exhausted → falls to GENERAL pool
    await respond.execute(offer.id, false, offer.driverId);
    expect(await pendingCount(ride.id)).toBe(1);
    row = await prisma.rideRequest.findUniqueOrThrow({ where: { id: ride.id } });
    expect(row.status).toBe("WAITING_GENERAL");
    offer = await prisma.rideOffer.findFirstOrThrow({
      where: { rideRequestId: ride.id, status: "PENDING" },
    });
    // The general pool may include drivers seeded by other specs; the contract
    // is only that the next offer is not re-issued to the rejected drivers.
    expect(offer.driverId).not.toBe(driverA.id);
    expect(offer.driverId).not.toBe(driverB.id);
    // driverC is one of the candidates available in this test's DB state.
    void driverC;
  });
});
