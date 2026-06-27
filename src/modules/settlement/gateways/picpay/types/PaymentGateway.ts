/**
 * PaymentGatewayAuth — abstração de autenticação OAuth2 para provedores de
 * liquidação financeira.
 */
export interface PaymentGatewayAuth {
  /**
   * Retorna um access token válido.
   * A implementação é responsável por gerenciar o ciclo de vida do token
   * (cache, renovação, etc.).
   */
  getAccessToken(): Promise<string>;
}

/**
 * PaymentGateway — contrato principal para integração com provedores Pix.
 */
export interface PaymentGateway {
  /**
   * Cria uma intenção de pagamento Pix no provedor e retorna os dados
   * necessários para o frontend exibir o QR Code / copia-e-cola.
   */
  createPaymentIntent(input: {
    amountCents: number;
    externalId: string;
    description?: string;
    cpf?: string;
    pixKey?: string;
  }): Promise<{
    id: string;
    status: string;
    brCode?: string;
    qrCodeUrl?: string;
  }>;

  /**
   * Consulta o status de uma intenção de pagamento no provedor.
   */
  getPaymentStatus(externalId: string): Promise<{
    status: string;
    paidAt?: Date;
  }>;

  /**
   * Cancela uma intenção de pagamento, se ainda estiver pendente.
   */
  cancelPayment(externalId: string): Promise<void>;
}