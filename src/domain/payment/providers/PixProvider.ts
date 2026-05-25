/**
 * PixProvider — port for Pix payment integration.
 *
 * PR-2 ships the InMemory adapter only. Real providers (Mercado Pago / Asaas /
 * Efí) will plug in via this interface in PR-3.
 */

export interface PixChargeInput {
  intentId: string;
  amountCents: number;
  description?: string;
}

export interface PixChargeResult {
  /** Provider-side reference; doubles as idempotency key for webhooks. */
  externalId: string;
  /** Pix copy-paste string ("emv" / "copia-cola"). */
  qrCode: string;
  /** Base64 PNG of the QR code. */
  qrCodeImage: string;
}

export interface PixProvider {
  createCharge(input: PixChargeInput): Promise<PixChargeResult>;
}
