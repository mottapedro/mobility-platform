/**
 * DTO de entrada para criação de PaymentIntent no PicPay.
 */
export interface PaymentIntentDTO {
  amountCents: number;
  externalId: string;
  description?: string;
  cpf?: string;
  pixKey?: string;
}