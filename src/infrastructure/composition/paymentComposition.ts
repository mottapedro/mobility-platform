import { createEventBus, EventBus } from "../../domain/shared/events/EventBus";
import { InMemoryPixProvider } from "../../domain/payment/providers/InMemoryPixProvider";
import { PixProvider } from "../../domain/payment/providers/PixProvider";

let busSingleton: EventBus | null = null;
let providerSingleton: PixProvider | null = null;

export function getEventBus(): EventBus {
  if (!busSingleton) busSingleton = createEventBus();
  return busSingleton;
}

export function getPixProvider(): PixProvider {
  if (!providerSingleton) providerSingleton = new InMemoryPixProvider();
  return providerSingleton;
}
