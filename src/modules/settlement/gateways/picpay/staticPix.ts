/**
 * PIX Estatico — gerador de payload BRCode/EMVCo conforme manual do Banco Central do Brasil.
 * Spec: II_ManualdePadroesparaIniciacaodoPix — secao 3 (QR Code Estatico)
 *
 * CRC: CRC-16/CCITT-FALSE (polinomio 0x1021, valor inicial 0xFFFF, sem reflexao I/O)
 */

// ─── CRC-16/CCITT-FALSE ──────────────────────────────────────────────────────

export function crc16(payload: string): number {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000
        ? ((crc << 1) ^ 0x1021) & 0xffff
        : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// ─── TLV builder (Tag-Length-Value, comprimento decimal com 2 digitos) ────────

function tlv(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

// ─── Remover diacriticos (acentos) — U+0300 ate U+036F ───────────────────────

const DIACRITICS_RE = new RegExp("[̀-ͯ]", "g");

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(DIACRITICS_RE, "");
}

// ─── Parametros do payload ────────────────────────────────────────────────────

export interface StaticPixParams {
  /** Chave PIX do recebedor (EVP/UUID, CPF, CNPJ, e-mail ou telefone) */
  pixKey: string;
  /** Nome do recebedor — max 25 caracteres, sem acentos (BCB spec ID 59) */
  merchantName: string;
  /** Cidade do recebedor — max 15 caracteres, sem acentos (BCB spec ID 60) */
  merchantCity: string;
  /** Valor da transacao em Reais com ate 2 casas decimais (ex: 42.50) */
  amountBrl: number;
  /** Identificador livre da transacao — vira reference label no campo ID 62.05 (max 25 chars) */
  txid?: string;
}

// ─── Gerador do payload EMVCo ─────────────────────────────────────────────────

export function buildStaticPixPayload(params: StaticPixParams): string {
  const { pixKey, merchantName, merchantCity, amountBrl, txid } = params;

  // Limpar e truncar conforme limites maximos da spec BCB
  const name = stripAccents(merchantName).trim().slice(0, 25);
  const city = stripAccents(merchantCity).trim().slice(0, 15);

  // Reference label: apenas alfanumerico, max 25 chars; "***" quando nao informado
  const referenceLabel = txid
    ? txid.replace(/[^a-zA-Z0-9]/g, "").slice(0, 25) || "***"
    : "***";

  // ID 26 — Merchant Account Information (sub-campos PIX)
  //   00: GUI obrigatorio (identifica que e PIX)
  //   01: Chave PIX do recebedor
  const merchantAccountInfo =
    tlv("00", "BR.GOV.BCB.PIX") +
    tlv("01", pixKey);

  // ID 62 — Additional Data Field Template
  //   05: Reference Label (identificador da transacao para conciliacao)
  const additionalDataField = tlv("05", referenceLabel);

  // Montar corpo do payload; "6304" fecha o campo CRC sem o valor (calculado a seguir)
  const body = [
    tlv("00", "01"),                       // Payload Format Indicator
    tlv("01", "11"),                       // Point of Initiation: 11 = estatico (reutilizavel)
    tlv("26", merchantAccountInfo),        // Merchant Account Information (PIX)
    tlv("52", "0000"),                     // Merchant Category Code (nao especificado)
    tlv("53", "986"),                      // Transaction Currency: 986 = BRL
    tlv("54", amountBrl.toFixed(2)),       // Transaction Amount
    tlv("58", "BR"),                       // Country Code
    tlv("59", name),                       // Merchant Name (max 25)
    tlv("60", city),                       // Merchant City (max 15)
    tlv("62", additionalDataField),        // Additional Data Field Template
    "6304",                                // CRC16 — tag "63" + comprimento "04" fixo
  ].join("");

  const checksum = crc16(body).toString(16).toUpperCase().padStart(4, "0");
  return body + checksum;
}
