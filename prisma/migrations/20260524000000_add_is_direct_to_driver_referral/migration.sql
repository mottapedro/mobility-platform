-- Add isDirect column to DriverReferral closure table.
-- isDirect=true  → edge estrutural direta (A indicou B pessoalmente)
-- isDirect=false → edge herdada/transitiva  (closure propagation)
-- Default=true é seguro para todas as rows existentes porque antes desta migration
-- a propagação herdada estava bugada e nenhuma edge herdada foi criada corretamente.

ALTER TABLE "DriverReferral" ADD COLUMN "isDirect" BOOLEAN NOT NULL DEFAULT true;

-- Index para anti-loop e queries de analytics por tipo de edge
CREATE INDEX "DriverReferral_referrerDriverId_isDirect_idx" ON "DriverReferral"("referrerDriverId", "isDirect");
