/**
 * GUARDAS ESTÁTICAS — Supabase E2E Expired Offer Discovery (somente leitura)
 *
 * Provam o contrato sem tocar no banco:
 *  - o workflow só dispara manualmente (workflow_dispatch), sem permissões de escrita
 *    e sem referência a DIRECT_URL;
 *  - o script usa session pooler + TLS com CA, abre transação READ ONLY, nunca emite
 *    verbos SQL de escrita, não projeta Passenger/User.email/origem/destino, e só
 *    imprime chaves presentes no allowlist EMISSION_KEYS;
 *  - o token de sucesso só é emitido após ROLLBACK e desconexão.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const WORKFLOW_PATH = path.resolve(".github/workflows/supabase-e2e-expired-offer-discovery.yml");
const SCRIPT_PATH = path.resolve("scripts/e2e/supabase-e2e-expired-offer-discovery.cjs");
const workflow = fs.readFileSync(WORKFLOW_PATH, "utf8");
const script = fs.readFileSync(SCRIPT_PATH, "utf8");
const { EMISSION_KEYS }: { EMISSION_KEYS: string[] } = require(SCRIPT_PATH);

describe("Workflow — Supabase E2E Expired Offer Discovery (arquitetura)", () => {
  it("só dispara manualmente: on = workflow_dispatch (sem push/pull_request)", () => {
    expect(workflow).toMatch(/^on:\s*$/m);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).not.toContain("pull_request");
  });

  it("permissões mínimas: contents: read", () => {
    expect(workflow).toMatch(/^permissions:\s*$/m);
    expect(workflow).toContain("contents: read");
  });

  it("executa no ambiente E2E persistente com secrets certificados", () => {
    expect(workflow).toContain("environment: supabase-e2e-migration");
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toContain("timeout-minutes: 15");
    expect(workflow).toContain("DATABASE_URL: ${{ secrets.OFFER_BOOK_SUPABASE_E2E_DATABASE_URL }}");
    expect(workflow).toContain("E2E_CA_CERT: ${{ secrets.OFFER_BOOK_SUPABASE_E2E_CA_CERT }}");
    expect(workflow).not.toContain("DIRECT_URL");
  });

  it("instala deps sem lifecycle scripts e executa o script de descoberta", () => {
    expect(workflow).toContain("npm ci --include=dev --ignore-scripts");
    expect(workflow).toContain("node scripts/e2e/supabase-e2e-expired-offer-discovery.cjs");
    expect(workflow).not.toContain("prisma migrate");
  });
});

describe("Script — descoberta SOMENTE LEITURA (arquitetura)", () => {
  it("exige session pooler do projeto certificado, DATABASE_URL e CA do E2E", () => {
    expect(script).toContain("require('./supabase-target.cjs')");
    expect(script).toContain("const { Client } = require('pg')");
    expect(script).toContain("required('DATABASE_URL')");
    expect(script).toContain("required('E2E_CA_CERT')");
    expect(script).toContain("SESSION_POOLER_REQUIRED");
    expect(script).toContain("TARGET_IDENTITY_FAILURE");
  });

  it("força TLS com CA do ambiente e transação READ ONLY", () => {
    expect(script).toContain("rejectUnauthorized: true");
    expect(script).toMatch(/BEGIN TRANSACTION READ ONLY/);
    expect(script).toContain("transaction_read_only");
    expect(script).toContain("READ_ONLY_ENFORCEMENT_FAILURE");
  });

  it("não contém verbos SQL de escrita", () => {
    const writeVerbs = /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|merge|copy)\b/i;
    expect(script).not.toMatch(writeVerbs);
  });

  it("não projeta nem emite Passenger, User.email, origem, destino ou datas", () => {
    for (const forbidden of ['"origin"', '"destination"', '"passengerId"', '"originLat"', '"destinationLat"', ".email", '"User"', "public.\"Passenger\""]) {
      expect(script).not.toContain(forbidden);
    }
    expect(script).toContain("ORIGIN_DESTINATION_PII_EXPOSURE");
    expect(script).toContain("NONE_EMITTED");
  });

  it("descobre ofertas expiradas via status::text = 'EXPIRED' no allowlist RideOffer", () => {
    expect(script).toContain("status::text = 'EXPIRED'");
    expect(script).toContain("FROM public.\"RideOffer\"");
    expect(script).toContain("JOIN public.\"RideRequest\" rr");
  });

  it("só emite chaves do allowlist EMISSION_KEYS", () => {
    const emitCalls = [...script.matchAll(/emit\('([A-Z0-9_]+)'/g)].map((match) => match[1]);
    expect(emitCalls.length).toBeGreaterThan(10);
    for (const key of emitCalls) expect(EMISSION_KEYS).toContain(key);
    expect(EMISSION_KEYS.every((key) => !/(^|_)USER(EMAIL)?(_|$)|PASSENGER|EMAIL/.test(key))).toBe(true);
  });

  it("nivela autoridades: nenhuma escrita nem migração é autorizada", () => {
    expect(script).toContain("MIGRATE_DEPLOY_AUTHORITY");
    expect(script).toContain("'DENIED'");
    expect(script).toContain("WRITE_QUERY_ATTEMPTED");
    expect(script).toContain("DDL_ATTEMPTED");
    expect(script).toContain("DML_ATTEMPTED");
    expect(script).toContain("SECRET_EXPOSED");
    expect(script).toContain("LOGS_SANITIZED");
    expect(script).toContain("'READ_ONLY'");
  });

  it("só conclui (PASS) após ROLLBACK e desconexão", () => {
    const rollbackIndex = script.indexOf("await client.query('ROLLBACK')");
    const endIndex = script.indexOf("await client.end()");
    const resultIndex = script.indexOf("emit('EXPIRED_OFFER_DISCOVERY_RESULT'");
    expect(rollbackIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(rollbackIndex);
    expect(resultIndex).toBeGreaterThan(endIndex);
  });
});