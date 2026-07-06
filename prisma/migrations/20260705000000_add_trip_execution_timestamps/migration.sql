-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260705000000_add_trip_execution_timestamps
-- Trip Execution Domain — Fase 4
--
-- Materializa os micro-estados operacionais da viagem como timestamps
-- imutáveis na RideRequest. Cada campo representa um evento de domínio
-- congelado no momento em que ocorreu.
--
-- Princípio ADD ONLY:
--   Apenas adiciona colunas e índices.
--   Nenhuma coluna existente é alterada, renomeada ou removida.
--
-- Impacto:
--   ✅ Não altera RideStatus público
--   ✅ Não quebra queries existentes (todas colunas nullable)
--   ✅ Corridas anteriores ficam com todos os campos NULL (sem efeito)
--
-- Após aplicar:
--   npx prisma migrate deploy   ← aplica esta migration
--   npx prisma generate         ← regenera o client
--   Reiniciar o servidor backend
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "RideRequest"
  -- Momento em que o driver iniciou a navegação ao passageiro
  ADD COLUMN IF NOT EXISTS "navigationStartedAt"  TIMESTAMP(3),

  -- Momento em que o driver chegou ao local de embarque
  ADD COLUMN IF NOT EXISTS "pickupArrivedAt"       TIMESTAMP(3),

  -- Momento em que o passageiro confirmou embarque
  ADD COLUMN IF NOT EXISTS "boardingAt"            TIMESTAMP(3),

  -- Momento em que a viagem foi iniciada (driver → destino)
  ADD COLUMN IF NOT EXISTS "tripStartedAt"         TIMESTAMP(3),

  -- Momento em que o driver chegou ao destino
  ADD COLUMN IF NOT EXISTS "destinationArrivedAt"  TIMESTAMP(3),

  -- Momento em que a viagem foi encerrada (transição → COMPLETED)
  ADD COLUMN IF NOT EXISTS "completedAt"           TIMESTAMP(3);

-- Índice para analytics de tempo de execução por estágio
CREATE INDEX IF NOT EXISTS "RideRequest_tripStartedAt_idx"
  ON "RideRequest" ("tripStartedAt");

CREATE INDEX IF NOT EXISTS "RideRequest_completedAt_idx"
  ON "RideRequest" ("completedAt");
