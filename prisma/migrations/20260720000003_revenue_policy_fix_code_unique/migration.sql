-- Migration: remove unique constraint on RevenuePolicy.code alone
-- Múltiplas versões do mesmo code são permitidas; unicidade é por (code, version).
-- ADR-002 v1.1 §5 — "version: incrementado a cada nova vigência do mesmo code"

DROP INDEX IF EXISTS "RevenuePolicy_code_key";
