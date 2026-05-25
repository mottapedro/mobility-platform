-- Aliado V2 — Stage 2.A — Enum centralization
--
-- 1. Extend DomainEventType with lifecycle events emitted by the new
--    application services + RideExecutionDomain orchestrator.
-- 2. Introduce OwnershipType as the canonical taxonomy for network
--    ownership (used by NetworkOwnershipService + future projections).

ALTER TYPE "DomainEventType" ADD VALUE IF NOT EXISTS 'OFFER_CREATED';
ALTER TYPE "DomainEventType" ADD VALUE IF NOT EXISTS 'RIDE_FINALIZED';
ALTER TYPE "DomainEventType" ADD VALUE IF NOT EXISTS 'SETTLEMENT_CONFIRMED';
ALTER TYPE "DomainEventType" ADD VALUE IF NOT EXISTS 'LINEAGE_RESOLVED';
ALTER TYPE "DomainEventType" ADD VALUE IF NOT EXISTS 'SKILL_ASSIGNED';

CREATE TYPE "OwnershipType" AS ENUM (
  'ROOT_DRIVER',
  'INHERITED_DRIVER',
  'DIRECT_PASSENGER',
  'INHERITED_PASSENGER',
  'LATERAL'
);
