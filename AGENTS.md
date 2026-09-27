# AGENTS.md — Mobility Platform Engineering Constitution

> Single source of truth for engineering conventions, mandatory pipelines, and merge-blocking rules. Tool-agnostic: read by Copilot, Cursor, Cline, Claude Code, and humans.
> Last revision: 2026-06-05 (Aliado commit and push governance protocol added §12).

---

## 1. Project context

Mobility platform with a **governed sequential dispatch runtime** at its core. Stack: TypeScript / Node.js / Express / Prisma 7.8 / PostgreSQL 16 / Jest. Two operational subsystems require special discipline:

- **Schema layer** — Prisma schema, generated client, and the live database must stay in lock-step. Drift is treated as a P0 incident class (`Schema Contract Drift`).
- **Dispatch runtime** — `MatchRideUseCase`, `dispatchSingle`, the partial unique index `RideOffer_one_pending_per_ride`, and the `DispatchStage` / `RideStatus` lifecycle enforce one active PENDING offer per ride. Never restore broadcast loops.

Existing governance assets:
- [.github/workflows/godnetwork-governance.yml](.github/workflows/godnetwork-governance.yml) — CI gate
- [scripts/network/audit-godnetwork-governance.ts](scripts/network/audit-godnetwork-governance.ts) — relational graph audit
- [tests/setup.ts](tests/setup.ts) — test data cleanup (policy lives in this file; see §6)
- [tests/contracts/](tests/contracts/) — DMMF-driven schema contract suite (see §7)

---

## 2. Schema Change Pipeline (mandatory, no exceptions)

> **Known incident — `DomainEventType` ordering (2026-05-26):** Migration
> `20260526190329` was originally written as `ALTER TYPE "DomainEventType" ADD VALUE 'DRIVER_REFERRED'`
> assuming the type existed — but no prior migration in the chain created it.
> Failed on every fresh DB with `SQLSTATE 42704 — type "DomainEventType" does not exist`.
> Root cause: author developed against a local DB that already had the type
> (from a later migration already applied locally) and did not notice the implicit
> forward dependency. Fix: the migration was updated to `CREATE TYPE "DomainEventType"
> AS ENUM ('DRIVER_REFERRED')` wrapped in a DO $$ EXCEPTION block (idempotent).
> **Derived rule:** any migration using `ALTER TYPE` must either (a) confirm a
> prior migration in the same chain creates the type, or (b) include the
> `CREATE TYPE` itself.

Every change to `prisma/schema.prisma` MUST execute the following steps in order. Each is a hard gate — no commit if any step fails.

```
1.  edit prisma/schema.prisma
2.  write migration SQL  (prisma/migrations/<timestamp>_<name>/migration.sql)
3.  npx prisma migrate deploy      # NOT migrate dev — shadow DB has stale-migration block
4.  npx prisma generate
5.  npx tsc --noEmit -p tsconfig.json
6.  npm run test:contracts         # schema ↔ client ↔ DB drift detector
7.  npx jest --runInBand --forceExit
```

Why `migrate deploy` instead of `migrate dev`: an old migration (`20260526190329_add_driver_referred_event`) references a `RevenueSplit` table the shadow DB cannot reproduce, so `migrate dev` is permanently blocked. Apply migrations explicitly.

### Regras para Enums

Enums são considerados ativos críticos.

Antes de remover valores:

1. Inventariar dados existentes.

```sql
SELECT status, COUNT(*)
FROM "<Table>"
GROUP BY status;
```

2. Criar migration de saneamento.
3. Executar saneamento.
4. Contrair o enum.

Jamais remover valores de enum sem auditoria prévia.

### Regras para Dados Econômicos

As entidades abaixo são consideradas imutáveis:

- `Settlement`
- `RevenueSplit`
- `RewardDistribution`

Correções devem ser feitas via eventos compensatórios.

Nunca executar `DELETE` ou `UPDATE` destrutivo em produção.

### Migrations absorvidas pela baseline (Estratégia A)

Efeitos de migrations locais que já estejam **integralmente** presentes na baseline
(`20260101000000_init_baseline`) e nos bancos físicos (local, HML) **não devem ser
versionados**. Trata-se da Estratégia A de governança de migrations:

1. Confirmar nominalmente cada efeito no `prisma/schema.prisma` e no SQL da baseline
   (enums, colunas, tabelas, índices, FKs e ações ON DELETE/ON UPDATE).
2. Confirmar a presença física em todos os ambientes alvo (local, HML, CI, produção).
3. **Não** adicionar essas migrations ao catálogo histórico
   (`scripts/baseline-resolve-historical.ts`), **não** executar `migrate resolve`
   em ambientes que já as possuem aplicadas e **não** versionar os diretórios antigos.
4. Registrar a decisão aqui (documentação de governança) antes de qualquer commit de runtime.

Exemplo vigente: `20260706000000_trip_execution_boundary` e `20260720000000_gps_tracking`
(`RideOfferStatus.PAID`, `DomainEventType.TRIP_EXECUTION_STARTED`, `navigationStartedAt`,
tabela `DriverLocationPing` com índice e FKs) já estão absorvidos pela baseline — os
diretórios permanecem **fora do versionamento**.

Evolução futura: qualquer mudança na funcionalidade Trip/GPS deve entrar como **nova
migration pós-cutoff** (timestamp superior a `20260720000005_ownership_policy`),
nunca reutilizando ou reintroduzindo os diretórios absorvidos.

Cuidado: `git add -A` cego pode incluir pastas de migrations absorvidas; o guard do CI
falhará de propósito se uma migration não catalogada aparecer em `git ls-tree HEAD`.

---

## 3. Rename Rule — Expand / Migrate / Contract

Direct `ALTER TABLE ... RENAME COLUMN` on a column that any code reads or writes is **forbidden**. Use the four-phase pattern:

| Phase | Action |
|---|---|
| **A — Expand** | `ALTER TABLE ... ADD COLUMN <newName> <type>;` Both columns coexist. |
| **B — Backfill** | One-shot script or `UPDATE` copying `<oldName> → <newName>`. |
| **C — Migrate code** | All writers write to `<newName>`. Readers prefer `<newName>`, fall back to `<oldName>` only during a deploy window. |
| **D — Contract** | `ALTER TABLE ... DROP COLUMN <oldName>;` Allowed only after one green deploy with code on `<newName>`. |

### Exception: single-branch in-flight rename

A direct rename in a single migration is permitted **only if all three conditions hold**:

1. The column was introduced in the *previous unmerged commit* on the *same branch*.
2. The introducing migration has never been deployed beyond a developer's local DB.
3. The branch has no open PRs targeting `main`.

The `currentStage → currentDispatchStage` refactor (`28d19b4`) is the canonical example of this exception — the introducing migration (`20260601000000_add_ride_dispatch_queue_state`, `ac9d779`) had only ever run on dev.

For renames touching production or staging schema, **no exception applies** — use Expand / Migrate / Contract.

---

## 4. Merge Blockers

Any of the following blocks merge unconditionally — fix before requesting review:

- `P2022` ColumnNotFound surfaced anywhere (tests, `tsc`, server logs).
- `P2021` TableNotFound surfaced anywhere.
- `npx prisma migrate status` reports drift (pending, edited, or failed migration).
- `npm run test:contracts` is red.
- Any Prisma enum value present in TypeScript source but absent from the generated client (or vice versa).
- `npx tsc --noEmit` errors of any kind.
- `npx jest --runInBand --forceExit` failures (transient flakes: rerun once; if persistent, fix or quarantine with an issue link).

---

## 5. Dispatch Runtime Invariants (do not regress)

These are enforced by code, tests, and a partial unique index. Do not loosen:

- **One active PENDING offer per ride.** Enforced by `MatchRideUseCase.dispatchSingle` (pre-check + `try/catch` on unique constraint) and the partial index `RideOffer_one_pending_per_ride ON "RideOffer" ("rideRequestId") WHERE status = 'PENDING'`.
- **No broadcast loops.** Never reintroduce `for (const driver of drivers) await createOffer(...)`. Sequential dispatch is the contract. See [src/application/use-cases/MatchRideUseCase.ts](src/application/use-cases/MatchRideUseCase.ts).
- **Lifecycle status reflects dispatch tier.** `WAITING_REFERRAL` (Tier 1 referred driver) → `WAITING_PARTNER` (network L1/L2/L3) → `WAITING_GENERAL` (region/global pool). `MATCHING` is only the brief transition before the first dispatch of a non-referred ride.
- **`DispatchStage` is the persisted runtime mechanic.** `RideStatus` is the UX surface. They are distinct concerns; never overload one with the other.
- **Application-layer `type MatchLevel` is the matching priority classifier.** It is *not* a persistence shape and must not be assigned to a Prisma enum column.
- **Re-dispatch entry point is `dispatchNextCandidate({ rideId })`.** Reject / expire paths call it; they must not re-issue offers themselves.
- **All schedulers register with `lifecycle`** (`matchingJobScheduler`, `referralFallbackScheduler`) so `shutdownAsync` drains them gracefully. Adding a new scheduler? Register it.

---

## 6. Test Data Policy (canonical)

Defined and implemented in [tests/setup.ts](tests/setup.ts). Restated here as the source of truth:

- Production drivers use `@driver.com` and `mottapedro01@gmail.com`. **Production data is never touched by tests.**
- All test-created records MUST use an email ending in one of the `TEST_EMAIL_DOMAINS` registered in `tests/setup.ts`. To add a new domain, edit that array.
- The `cleanTestData()` helper is the only sanctioned destructive operation; it filters strictly by `TEST_EMAIL_DOMAINS`.

**Forbidden in tests:**

```ts
prisma.*.deleteMany({})              // no naked deleteMany
prisma.$executeRaw("TRUNCATE ...")   // no truncate
prisma.user.deleteMany()             // no unfiltered deleteMany
```

---

## 7. Contract Test Suite — `tests/contracts/`

Single DMMF-driven harness ([tests/contracts/schema-contract.spec.ts](tests/contracts/schema-contract.spec.ts)) iterates every Prisma model and verifies every scalar + enum field exists in the live database. Catches drift before any business test runs.

- **Scope:** scalar columns (including FK scalars like `driverId`) and enum columns. Relation accessors are deliberately excluded.
- **Auto-scaling:** new models and columns are covered automatically — no per-model spec to maintain.
- **Runtime:** sub-second on a warm DB.
- **Run:** `npm run test:contracts`.
- **CI:** gated in `.github/workflows/godnetwork-governance.yml` after `prisma migrate deploy`.

---

## 8. Build, test, and operational commands

| Command | Purpose |
|---|---|
| `npm run dev` | nodemon dev server with ts-node |
| `npm run build` | `tsc` to `dist/` |
| `npm start` | run compiled server |
| `npm test` | full Jest suite (`--runInBand --forceExit`) |
| `npm run test:contracts` | schema contract suite only (<3s) |
| `npm run test:e2e` | Playwright |
| `npx prisma migrate deploy` | apply pending migrations to the configured DB |
| `npx prisma generate` | regenerate Prisma client |
| `npx prisma migrate status` | verify schema/migration parity |
| `npm run audit:godnetwork` | relational graph governance audit |
| `npm run seed:golden` | seed the golden network fixture |

### Seeds e GodNetwork

O **GodNetwork** é a rede de dados de referência utilizada para homologação, testes E2E, regressão e demonstrações.

**Estrutura de seeds:**

```
prisma/seeds/
├── god-network.seed.ts      # Rede dourada completa
├── drivers.seed.ts          # Motoristas seed
├── passengers.seed.ts       # Passageiros seed
├── rides.seed.ts            # Corridas em todos os status
├── offers.seed.ts           # Ofertas em todos os status
├── settlements.seed.ts      # Dados econômicos (homologação only)
└── operational-zones.seed.ts # Zonas operacionais
```

**Scripts NPM:**

```json
{
  "seed:god-network": "tsx prisma/seeds/god-network.seed.ts",
  "seed:homolog": "tsx prisma/seeds/homolog.seed.ts",
  "seed:reset": "prisma migrate reset --force && npm run seed:god-network"
}
```

**Cenários E2E obrigatórios:**

- **E2E-001:** Passenger cria corrida → Driver recebe oferta → Driver aceita → Ride ACCEPTED
- **E2E-002:** `/invite/d2p/{code}` → redirect → onboarding → cadastro
- **E2E-003:** Referral → Cadastro → Corrida → Ownership

**Convenções de IDs:**

Utilizar IDs previsíveis:

```
drv_root_a, drv_root_b, psg_001, ride_001, offer_001
```

**Regras de seeds:**

- Seeds devem ser **idempotentes** (usar `upsert()`, jamais `create()` isoladamente)
- É proibido editar dados seed manualmente no banco
- É proibido criar usuários de teste fora das seeds
- É proibido utilizar IDs aleatórios
- É proibido depender de dados existentes na máquina do desenvolvedor

**Dados obrigatórios por entidade:**

- **Driver seed:** `id, name, email, phone, referralCode, rating, operationalZones, vehicle, pixKey`
- **Passenger seed:** `id, name, email, phone, rootDriverId`
- **Ownership:** toda seed deve possuir `rootDriverId` e `operationalOwnerId`

**Execução:**

- Desenvolvimento: `npm run seed:god-network`
- Homologação: `npm run seed:homolog`
- Reset completo: `npm run db:reset && npm run seed:god-network`

---

## 9. Platform notes

- **OS:** Windows (PowerShell 5.1). Chain commands with `;` — never `&&`. Quote paths containing spaces.
- **TypeScript target:** ES2020. No `AggregateError` literal; use `Error & { errors: unknown[] }` shapes.
- **Prisma JSON nullable:** assign `Prisma.DbNull`, not literal `null`. Import via `import { Prisma } from "@prisma/client"`.

---

## 10. Branch and commit conventions

- Feature branches: `feat/<area>-<short-description>` (current: `feat/aliado-v2-domain-hardening`).
- Commit subject: `<type>(<scope>): <imperative summary>` — see §12 for allowed scopes.
- Use `-m` flags repeatedly for multi-paragraph body; do not embed newlines in a single `-m`.
- Never `git push --force`, `git reset --hard` on a published branch, or `--no-verify` to bypass hooks. Diagnose; do not bypass.
- Every commit must be preceded by the pre-commit checklist in §12 and followed by the post-commit checklist in §12.

---

## 11. When in doubt

- Treat undocumented friction as a governance gap. Open a PR to update this file before adding a workaround.
- Schema drift is never "the test's fault" — it is always a contract integrity issue. Fix the contract.
- Sequential dispatch invariants are not negotiable for perceived performance gains. Optimize within the invariant, not around it.

---

## 12. Commit and Push Protocol (Aliado — mandatory)

No commit may be created automatically after an isolated fix. Every commit requires the full pre-commit checklist to pass and the full post-commit checklist to confirm delivery.

### Pre-commit checklist (all items required)

1. Run tests related to the change.
2. Run all repository-defined mandatory static checks before commit.
   - Typecheck: `npx tsc --noEmit -p tsconfig.json`
   - Lint is a mandatory executable pre-commit check only when this repository defines a governed lint command and its required tooling and configuration. Do not invent or install a lint tool merely to satisfy this checklist.
3. Confirm there are no unrelated changes in the workspace (`git diff --stat`).
4. Confirm the current branch is the active PR branch.
5. Confirm the commit represents a complete functional delivery, not just a point fix.
6. Generate evidence of the validation (test output, tsc output, migrate status — whichever applies).

### Post-commit checklist (all items required)

1. Execute `git push`.
2. Confirm the commit appears on the remote branch.
3. Confirm the PR contains the commit.
4. Only then consider the task complete.

### Allowed commit scopes

| Scope | Use for |
|---|---|
| `feat(aliado-v2)` | Aliado V2 domain features |
| `feat(domain)` | Core domain model changes |
| `feat(network-governance)` | Network governance features |
| `feat(dispatch)` | Dispatch runtime features |
| `feat(payment)` | Payment domain features |
| `fix(domain)` | Domain bug fixes |
| `fix(network)` | Network layer bug fixes |
| `fix(dispatch)` | Dispatch runtime bug fixes |
| `test(governance)` | Governance test suite additions/fixes |
| `test(runtime)` | Runtime contract test additions/fixes |
| `ci(governance)` | CI pipeline and governance tooling |
| `docs(governance)` | Engineering constitution updates (AGENTS.md) |
| `refactor(aliado-v2)` | Aliado V2 refactors (no behavior change) |
| `chore(governance)` | Governance scaffolding, tooling, scripts |

### Forbidden scope patterns

The following scope patterns are **forbidden** unless the task is exclusively technical and has been pre-approved:

```
fix(types)
fix(eslint)
fix(any)
fix(authApi)
```

Do not base commit subjects on file names or isolated technical details. The scope must reflect the domain or subsystem being changed.

### PR Template

Todo PR deve conter:

```markdown
## Objetivo
[Descrição clara do que está sendo resolvido]

## Impacto arquitetural
[Camadas/modules afetados]

## Alterações de schema
[Sim/Não — se sim, anexar migration revisada]

## Plano de rollback
[Como reverter se necessário]

## Evidências de testes
- [ ] `npm test` passou
- [ ] `npm run test:e2e` passou
- [ ] `npm run test:contracts` passou
- [ ] `npx tsc --noEmit` limpo
- [ ] `npx prisma migrate status` sem drift
```

BLOCKED UNTIL LIFECYCLE STABILIZATION

- RewardDistribution
- DispatchAttempt
- OperationalZone
- ReferralNetworkRankingService
- REGION -> REGIONAL rename
- Settlement refactor
- Ownership refactor
