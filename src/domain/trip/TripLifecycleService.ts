import { DomainEventType } from "../../shared/enums";
import { prisma } from "../../infra/prisma/client";
import { EventBus, recordAndPublish } from "../shared/events/EventBus";

export interface TripExecutionStartedPayload {
  id_oferta:    string;
  id_viagem:    string;
  evento:       "TRIP_EXECUTION_STARTED";
  ciclo_oferta: { estado_anterior: "ACCEPTED"; estado_final: "PAID" };
  ciclo_viagem: { novo_estado: "NAVIGATING_TO_PICKUP"; data_inicio_viagem: string };
  motorista_id:  string;
  passageiro_id: string;
  validador:     "SYS-GatewayPix";
}

export async function startTripExecution(
  paymentIntentId: string,
  bus: EventBus,
): Promise<void> {
  const intent = await prisma.paymentIntent.findUniqueOrThrow({
    where: { id: paymentIntentId },
    select: {
      rideRequestId: true,
      rideRequest: { select: { passengerId: true } },
    },
  });

  const { rideRequestId } = intent;

  const acceptedOffer = await prisma.rideOffer.findFirst({
    where: { rideRequestId, status: "ACCEPTED" },
    select: { id: true, driverId: true },
  });

  if (!acceptedOffer) {
    console.warn(`[TripLifecycle] No ACCEPTED offer for ride ${rideRequestId}; skipping trip boundary.`);
    return;
  }

  const now = new Date();

  await prisma.$transaction([
    prisma.rideOffer.update({
      where: { id: acceptedOffer.id },
      data:  { status: "PAID" },
    }),
    prisma.rideRequest.update({
      where: { id: rideRequestId },
      data:  { navigationStartedAt: now },
    }),
  ]);

  const payload: TripExecutionStartedPayload = {
    id_oferta:    acceptedOffer.id,
    id_viagem:    rideRequestId,
    evento:       "TRIP_EXECUTION_STARTED",
    ciclo_oferta: { estado_anterior: "ACCEPTED", estado_final: "PAID" },
    ciclo_viagem: { novo_estado: "NAVIGATING_TO_PICKUP", data_inicio_viagem: now.toISOString() },
    motorista_id:  acceptedOffer.driverId,
    passageiro_id: intent.rideRequest.passengerId,
    validador:     "SYS-GatewayPix",
  };

  await recordAndPublish(bus, {
    type:          DomainEventType.TRIP_EXECUTION_STARTED,
    aggregateType: "RideRequest",
    aggregateId:   rideRequestId,
    payload:       { ...payload },
  });
}
