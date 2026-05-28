-- Governed Sequential Dispatch — UX lifecycle statuses.
-- Phase 3 adds two new RideStatus values so the frontend can render
-- contextual messages while a ride waits for the next candidate:
--   WAITING_PARTNER  → "Buscando motoristas da rede de Pedro"
--   WAITING_GENERAL  → "Expandindo busca para motoristas disponíveis"
-- WAITING_DRIVER and WAITING_REFERRAL already exist on the enum.
ALTER TYPE "RideStatus" ADD VALUE IF NOT EXISTS 'WAITING_PARTNER';

ALTER TYPE "RideStatus" ADD VALUE IF NOT EXISTS 'WAITING_GENERAL';