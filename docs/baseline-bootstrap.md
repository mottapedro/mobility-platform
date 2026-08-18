# Baseline Bootstrap Runbook — Prisma

Guia para criar um banco novo a partir do baseline certificado, em vez de reprocessar as 43 migrations históricas uma a uma. Evita o histórico de falhas da cadeia (ex.: `20260526190329` dependia de `RevenueSplit` que não existia ainda).

## Artefatos

| Artefato | Papel |
|---|---|
| `prisma/migrations/20260101000000_init_baseline/migration.sql` | DDL completo do schema atual (22 tabelas, 18 enums, 28 FKs) |
| `scripts/prisma.bootstrap.ts` | Config Prisma isolada — usa `process.env.DATABASE_URL` diretamente, **sem** carregar `.env.local` com `override` |
| `scripts/baseline-resolve-historical.ts` | Marca as 43 migrations históricas como `applied` em bancos que já receberam o baseline |

> **IMPORTANTE sobre `.env.local`:** `prisma.config.ts` carrega `.env.local` com `override: true`, fazendo todo `npx prisma ...` apontar para o Supabase HML, independentemente de `$env:DATABASE_URL`. Por isso os comandos abaixo usam `--config scripts/prisma.bootstrap.ts` e exigem que `DATABASE_URL` seja exportado na sessão.

## Procedimento

### 1. Pré-condição

- Banco vazio (ou que será limpo).
- `prisma/migrations/20260101000000_init_baseline/migration.sql` presente.

### 2. Aplicar o baseline

```bash
$dbUrl = (Get-Content ".env.local" | Where-Object { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=', ''
$env:DATABASE_URL = $dbUrl
npx prisma db execute --config scripts/prisma.bootstrap.ts --file prisma/migrations/20260101000000_init_baseline/migration.sql
```

### 3. Marcar baseline como applied

```bash
npx prisma migrate resolve --config scripts/prisma.bootstrap.ts --applied 20260101000000_init_baseline
```

### 4. Resolver migrations históricas

```bash
npx tsx scripts/baseline-resolve-historical.ts
```

Ou, para um subconjunto (ex.: retomar um resolve interrompido):

```bash
npx prisma migrate resolve --config scripts/prisma.bootstrap.ts --applied <nome-da-migration>
```

### 5. Verificar

```bash
npx prisma migrate status --config scripts/prisma.bootstrap.ts
npx prisma migrate diff --config scripts/prisma.bootstrap.ts --from-config-datasource --to-schema=prisma/schema.prisma --exit-code
```

Esperado:

- `migrate status` → `Database schema is up to date!`
- `migrate diff` → `No difference detected.` com exit code 0
- `_prisma_migrations` → 44 registros (43 históricos + baseline), todos com `finished_at`

## Auditoria de FKs / indexes (read-only)

Scripts auxiliares (com `DATABASE_URL` exportado na sessão):

```bash
node scripts/hml-audit.mjs "$dbUrl"          # tabelas, enums, indexes, FKs, contagens
node scripts/hml-fk-audit.mjs "$dbUrl"       # FKs com ON DELETE/UPDATE
node scripts/hml-index-audit.mjs "$dbUrl"    # indexes com indexdef
node scripts/hml-migrations-audit.mjs "$dbUrl"  # registros de _prisma_migrations
```

Referência nominal:

- 22 tabelas, 18 enums de aplicação
- 28 FKs (idênticas entre baseline SQL e HML)
- 71 indexes de aplicação (22 `_pkey` + 49 explícitos) + 1 `_prisma_migrations_pkey` = 72

## Cuidados

- **Nunca** rodar `prisma migrate dev` — o shadow DB tem bloqueio permanente de migrations antigas (referência a `RevenueSplit` que não reproduz). Usar `migrate deploy` ou o fluxo acima.
- `migrate resolve --applied` é idempotente e não-destrutivo: só grava em `_prisma_migrations`.
- Em produção/staging, tratar divergências de contagem nominal (ex.: 71 vs 72 indexes) explicando a origem (`_prisma_migrations_pkey`), nunca mascare drift real — `migrate diff` é a verdade.
