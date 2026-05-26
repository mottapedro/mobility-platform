# Driver Network Evolution Agent — Design

## Goal

Define an operational agent/process that evolves the live Prisma/PostgreSQL schema and referral network safely, without destructive resets or data loss.

## Responsibilities

1. Keep `prisma/schema.prisma` aligned with the live database.
2. Apply incremental, non-destructive migrations.
3. Enforce pre/post data-integrity checks around every schema/data operation.
4. Bootstrap and backfill driver network links idempotently.

## Architecture

### 1) Schema Manager
- Runs `npx prisma db pull` against the configured `DATABASE_URL`.
- Compares pulled schema with tracked `prisma/schema.prisma`.
- Flags drift and proposes additive-first field changes (new columns optional by default).

### 2) Migration Handler
- Creates incremental migrations with Prisma migrate tooling.
- Rejects destructive operations (drop/reset) unless explicitly approved.
- Applies migrations in sequence and records outcomes.

### 3) Bootstrap Network Runner
- Reuses existing referral flow (`createDriverReferralChain`) and upsert-style behavior.
- Backfills new driver metadata fields (e.g. `publicSlug`, `networkLevel`, `referredByDriverId`) safely.
- Creates only missing nodes/edges, preserving existing `DriverReferral` links.

### 4) Validation Layer
- Pre-flight checks: connection health, schema compatibility, required tables/columns present.
- Post-flight checks: referral edge counts, orphan detection, passenger/driver preservation checks.
- Hard-fails on any destructive command path (`reset`, blanket deletes in production routines).

## Safe Execution Workflow

1. **Pull current schema**
   - `npx prisma db pull`
   - Validate drift report.
2. **Prepare schema update**
   - Additive changes only; new fields optional first.
3. **Run incremental migration**
   - Generate and apply migration.
   - Verify existing row counts stayed stable.
4. **Bootstrap/backfill network**
   - Execute bootstrap script idempotently.
   - Upsert missing data and preserve existing edges.
5. **Integrity validation**
   - Validate referral chain consistency and retained driver/passenger totals.

## Error Handling & Observability

- Structured logs for each phase (`schema-sync`, `migration`, `bootstrap`, `validation`).
- Every failure includes operation, entity, and remediation hint.
- Stop-the-world behavior on validation failure to prevent partial corruption.

## Future Extensions

- Referral/network analytics dashboards.
- Driver network gamification scoring.
- Real-time network update propagation.
