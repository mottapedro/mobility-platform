import "dotenv/config";
import { PicPayAuthService } from "./PicPayAuthService";
import { PaymentGateway, PaymentGatewayAuth } from "./types/PaymentGateway";

/**
 * PicPayGateway — implementação da interface PaymentGateway para o PicPay Payment Link API.
 * Documentação: https://ecommerce.picpay.com/
 * Endpoint: POST /v1/paymentlink/create
 */
export class PicPayGateway implements PaymentGateway {
  private readonly auth: PaymentGatewayAuth;
  private readonly apiUrl: string;

  constructor(auth?: PaymentGatewayAuth) {
    this.auth = auth ?? new PicPayAuthService();

    const apiUrl = process.env.PICPAY_API_URL;
    if (!apiUrl) {
      throw new Error("PICPAY_API_URL não configurada.");
    }
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  async createPaymentIntent(input: {
    amountCents: number;
    externalId: string;
    description?: string;
  }) {
    const token = await this.auth.getAccessToken();

    const url = `${this.apiUrl}/v1/paymentlink/create`;

    const body = {
      charge: {
        name: input.description || "Corrida Aliado",
        order_number: input.externalId.slice(-15),
        payment: {
          methods: ["BRCODE"],
          brcode_arrangements: ["PIX"],
        },
        amounts: {
          product: input.amountCents,
        },
      },
      options: {
        allow_create_pix_key: true,
      },
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Falha na conexão com PicPay (createPaymentIntent): ${message} — URL: ${url}`
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "sem corpo");
      console.error(
        `[PicPayGateway] createPaymentIntent FAILED — URL=${url} status=${response.status} body=${text}`
      );
      console.error(
        `[PicPayGateway] createPaymentIntent response headers:`,
        [...response.headers.entries()]
      );
      throw new Error(
        `PicPay createPaymentIntent retornou ${response.status}: ${text}`
      );
    }

    const payload: Record<string, unknown> = await response.json();

    // Mapeamento da resposta oficial do PicPay Payment Link
    const id: string = String(
      payload.txid ?? payload.referenceId ?? payload.externalId ?? input.externalId
    );
    const status: string = String(payload.status ?? "PENDING");

    const brCode: string | undefined =
      typeof payload.brcode === "string" ? payload.brcode : undefined;

    const qrCodeUrl: string | undefined =
      typeof payload.link === "string" ? payload.link : undefined;

    return {
      id,
      status,
      brCode,
      qrCodeUrl,
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