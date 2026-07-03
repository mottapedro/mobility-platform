import { createEventBus, EventBus } from "../../domain/shared/events/EventBus";
import { InMemoryPixProvider } from "../../domain/payment/providers/InMemoryPixProvider";
import { StaticPixProvider } from "../../domain/payment/providers/StaticPixProvider";
import { PixProvider } from "../../domain/payment/providers/PixProvider";

let busSingleton: EventBus | null = null;
let providerSingleton: PixProvider | null = null;

export function getEventBus(): EventBus {
  if (!busSingleton) busSingleton = createEventBus();
  return busSingleton;
}

// Chave EVP aprovada — fallback quando PICPAY_PIX_KEY não está no ambiente
const EVP_KEY = process.env.PICPAY_PIX_KEY ?? "91e47d2f-65f6-4b36-a33a-5af9ebc1c4e6";

export function getPixProvider(): PixProvider {
  if (!providerSingleton) {
    providerSingleton = process.env.NODE_ENV === "test"
      ? new InMemoryPixProvider()
      : new StaticPixProvider(EVP_KEY);
  }
  return providerSingleton;
}
