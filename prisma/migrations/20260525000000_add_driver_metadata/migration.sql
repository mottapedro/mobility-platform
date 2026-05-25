-- Add extensible metadata JSON column to Driver for skills, badges, and future attributes
-- (e.g. { "skills": ["Colecionador"], "badges": [], "tier": null })
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
