import {
  PixChargeInput,
  PixChargeResult,
  PixProvider,
} from "./PixProvider";

/**
 * Deterministic in-memory PixProvider used by tests and dev environments.
 *
 *  - externalId = `pix_<intentId>` (stable; allows webhook idempotency tests)
 *  - qrCode encodes intentId + amount so payloads are auditable in fixtures
 *  - Keeps an in-process map of charges for inspection
 */
export class InMemoryPixProvider implements PixProvider {
  private readonly charges = new Map<
    string,
    { intentId: string; amountCents: number; qrCode: string }
  >();

  async createCharge(input: PixChargeInput): Promise<PixChargeResult> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new Error(
        `InMemoryPixProvider: amountCents must be a positive integer, got ${input.amountCents}`
      );
    }

    const externalId = `pix_${input.intentId}`;
    const qrCode = `00020126_PIX_${input.intentId}_${input.amountCents}`;
    const qrCodeImage = Buffer.from(qrCode, "utf8").toString("base64");

    this.charges.set(externalId, {
      intentId: input.intentId,
      amountCents: input.amountCents,
      qrCode,
    });

    return { externalId, qrCode, qrCodeImage };
  }

  getCharge(externalId: string):
    | { intentId: string; amountCents: number; qrCode: string }
    | undefined {
    return this.charges.get(externalId);
  }

  reset(): void {
    this.charges.clear();
  }
}
