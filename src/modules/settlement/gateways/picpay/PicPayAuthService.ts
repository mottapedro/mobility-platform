import "dotenv/config";
import { PaymentGatewayAuth } from "./types/PaymentGateway";

/**
 * Cache entry holder for an OAuth2 access token.
 */
interface TokenCacheEntry {
  token: string;
  expiresAt: number; // epoch ms
}

/**
 * PicPayAuthService — gerencia autenticação OAuth2 contra a API do PicPay.
 *
 * Estratégia de cache:
 * - Armazena o token em memória (processo-local).
 * - Renova quando `Date.now() >= expiresAt - bufferMs`.
 * - Concorrência: se múltiplas chamadas ocorrerem durante a janela de renovação,
 *   a primeira faz a requisição e as demais esperam a promessa corrente.
 *
 * Configuração via `.env` (variáveis obrigatórias marcadas):
 * - PICPAY_CLIENT_ID (obrigatória)
 * - PICPAY_CLIENT_SECRET (obrigatória)
 * - PICPAY_API_URL (obrigatória) — base URL da API PicPay, ex: https://api.picpay.com
 * - PICPAY_TOKEN_CACHE_BUFFER_MS (opcional, padrão 240000 = 4min)
 *
 * Observação: o token do PicPay tem TTL declarado de 300s (5min). Usamos buffer
 * de 240s para renovar previamente e evitar 401 durante a requisição.
 */
export class PicPayAuthService implements PaymentGatewayAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tokenUrl: string;
  private readonly bufferMs: number;

  private cache: TokenCacheEntry | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor() {
    const clientId = process.env.PICPAY_CLIENT_ID;
    const clientSecret = process.env.PICPAY_CLIENT_SECRET;
    const apiUrl = process.env.PICPAY_API_URL;

    if (!clientId) {
      throw new Error("PICPAY_CLIENT_ID não configurada.");
    }
    if (!clientSecret) {
      throw new Error("PICPAY_CLIENT_SECRET não configurada.");
    }
    if (!apiUrl) {
      throw new Error("PICPAY_API_URL não configurada.");
    }

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenUrl = `${apiUrl.replace(/\/$/, "")}/oauth2/token`;
    this.bufferMs = parseInt(
      process.env.PICPAY_TOKEN_CACHE_BUFFER_MS ?? "240000",
      10
    );
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();

    if (this.cache && now < this.cache.expiresAt - this.bufferMs) {
      return this.cache.token;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.fetchNewToken();
    const token = await this.refreshPromise;
    this.refreshPromise = null;

    return token;
  }

  private async fetchNewToken(): Promise<string> {
    const body = {
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    };

    let response: Response;
    try {
      response = await fetch(this.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Falha na conexão com PicPay OAuth2: ${message}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "sem corpo");
      throw new Error(
        `PicPay OAuth2 retornou ${response.status}: ${text}`
      );
    }

    const payload: {
      access_token?: string;
      expires_in?: number;
    } = await response.json();

    if (!payload.access_token) {
      throw new Error("PicPay OAuth2 não retornou access_token.");
    }

    const expiresInSec = payload.expires_in ?? 300; // fallback 5 min
    const expiresAt = Date.now() + expiresInSec * 1000;

    this.cache = {
      token: payload.access_token,
      expiresAt,
    };

    return payload.access_token;
  }
}

export default PicPayAuthService;