import type { PushPayload } from "../../../infra/push/PushNotificationService";

export function buildPassengerEnRouteNotification(rideId: string): PushPayload {
  return {
    title:   "Seu Aliado está a caminho! 🚙",
    message: "O motorista já iniciou o trajeto. Acompanhe a chegada em tempo real pelo mapa.",
    data:    { screen: "RideTrackingMap", rideId },
  };
}

export function buildDriverOfferPaidNotification(rideId: string, offerId: string): PushPayload {
  return {
    title:   "Oferta Paga e Fechada! 💸",
    message: "O valor já está garantido pelo sistema. Você está liberado para iniciar o deslocamento até o passageiro.",
    data:    { screen: "TripExecution", rideId, offerId },
  };
}
