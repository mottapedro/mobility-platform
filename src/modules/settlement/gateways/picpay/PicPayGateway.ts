import "dotenv/config";
import { PicPayAuthService } from "./PicPayAuthService";
import { PaymentGateway, PaymentGatewayAuth } from "./types/PaymentGateway";
import { buildStaticPixPayload } from "./staticPix";

/**
 * PicPayGateway — implementação da interface PaymentGateway.
 *
 * createPaymentIntent: gera PIX Estático (EMVCo/BRCode) localmente, sem chamada HTTP.
 *   Motivo: portabilidade da chave CNPJ pendente no PicPay; conta apta apenas para chave EVP.
 *
 * getPaymentStatus / cancelPayment: ainda consultam a API PicPay para rastreio via webhook.
 */
export class PicPayGateway implements PaymentGateway {
  private readonly auth: PaymentGatewayAuth;
  private readonly apiUrl: string;
  private readonly pixKey: string | undefined;

  constructor(auth?: PaymentGatewayAuth) {
    this.auth = auth ?? new PicPayAuthService();

    const apiUrl = process.env.PICPAY_API_URL;
    if (!apiUrl) {
      throw new Error("PICPAY_API_URL não configurada.");
    }
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.pixKey = process.env.PICPAY_PIX_KEY;
  }

  async createPaymentIntent(input: {
    amountCents: number;
    externalId: string;
    description?: string;
  }) {
    const pixKey = this.pixKey;
    if (!pixKey) {
      throw new Error(
        "PICPAY_PIX_KEY nao configurada — impossivel gerar PIX Estatico sem chave EVP."
      );
    }

    const amountBrl = input.amountCents / 100;

    const brCode = buildStaticPixPayload({
      pixKey,
      merchantName: "Aliado Mobilidade",
      merchantCity: "Rio de Janeiro",
      amountBrl,
      txid: input.externalId,
    });

    console.log("[PicPayGateway] PIX Estatico gerado localmente (sem HTTP)", {
      externalId: input.externalId,
      amountBrl,
      brCodeLength: brCode.length,
      brCodePreview: brCode.slice(0, 50) + "...",
    });

    return {
      id: input.externalId,
      status: "PENDING",
      brCode,
      qrCodeUrl: undefined,
    };
  }

  async getPaymentStatus(externalId: string) {
    const token = await this.auth.getAccessToken();

    const url = `${this.apiUrl}/v1/paymentlink/${encodeURIComponent(externalId)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Falha na conexão com PicPay (getPaymentStatus): ${message} — URL: ${url}`
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "sem corpo");
      console.error(
        `[PicPayGateway] getPaymentStatus FAILED — URL=${url} status=${response.status} body=${text}`
      );
      throw new Error(
        `PicPay getPaymentStatus retornou ${response.status}: ${text}`
      );
    }

    const payload: Record<string, unknown> = await response.json();

    const status: string = String(payload.status ?? "UNKNOWN");

    const paidAtRaw = (payload.paidAt ?? payload.paid_at ?? payload.paidAtUtc) as
      | string
      | undefined;

    const paidAt = paidAtRaw ? new Date(paidAtRaw) : undefined;

    return {
      status,
      paidAt,
    };
  }

  async cancelPayment(externalId: string) {
    const token = await this.auth.getAccessToken();

    const url = `${this.apiUrl}/v1/paymentlink/${encodeURIComponent(externalId)}/inactive`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Falha na conexão com PicPay (cancelPayment): ${message} — URL: ${url}`
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "sem corpo");
      console.error(
        `[PicPayGateway] cancelPayment FAILED — URL=${url} status=${response.status} body=${text}`
      );
      throw new Error(
        `PicPay cancelPayment retornou ${response.status}: ${text}`
      );
    }

    if (response.status !== 204) {
      await response.text().catch(() => {});
    }
  }
}

export default PicPayGateway;