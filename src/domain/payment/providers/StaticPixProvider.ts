import { buildStaticPixPayload } from "../../../modules/settlement/gateways/picpay/staticPix";
import { PixChargeInput, PixChargeResult, PixProvider } from "./PixProvider";

export class StaticPixProvider implements PixProvider {
  private readonly pixKey: string;

  constructor(pixKey: string) {
    this.pixKey = pixKey;
  }

  async createCharge(input: PixChargeInput): Promise<PixChargeResult> {
    const amountBrl = input.amountCents / 100;

    const qrCode = buildStaticPixPayload({
      pixKey: this.pixKey,
      merchantName: "Aliado Mobilidade",
      merchantCity: "Rio de Janeiro",
      amountBrl,
      txid: input.intentId,
    });

    const externalId = `static_pix_${input.intentId}`;

    console.log("[StaticPixProvider] EMVCo gerado", {
      intentId: input.intentId,
      amountBrl,
      qrCodePreview: qrCode.slice(0, 60) + "...",
    });

    return { externalId, qrCode, qrCodeImage: "" };
  }
}
