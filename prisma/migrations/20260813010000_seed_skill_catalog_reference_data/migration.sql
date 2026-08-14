-- The Skill catalogue is mandatory domain reference data. Historical migration
-- 20260526000000 inserted these rows, but fresh databases use the consolidated
-- baseline and resolve that migration without executing its data statements.
-- Deterministic IDs avoid manufacturing a second identity for the same code.
INSERT INTO "Skill" ("id", "code", "displayName", "description") VALUES
  ('skill_colecionador',         'COLECIONADOR',         'Colecionador',         'Motorista com perfil de recorrência e fidelização.'),
  ('skill_executivo',            'EXECUTIVO',            'Executivo',            'Atende corridas executivas.'),
  ('skill_transporte_assistido', 'TRANSPORTE_ASSISTIDO', 'Transporte Assistido', 'Habilitado para passageiros que necessitam de apoio.'),
  ('skill_aeroporto',            'AEROPORTO',            'Aeroporto',             'Especialista em corridas para/de aeroporto.'),
  ('skill_long_distance',        'LONG_DISTANCE',        'Longa Distância',       'Corridas intermunicipais.'),
  ('skill_premium',              'PREMIUM',              'Premium',               'Veículo e atendimento premium.'),
  ('skill_vip',                  'VIP',                  'VIP',                   'Atendimento VIP.')
ON CONFLICT ("code") DO NOTHING;
