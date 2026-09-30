-- Identificador do lançamento na origem (FITID do OFX ou hash da linha do CSV).
-- Permite reimportar o mesmo arquivo sem duplicar nada.
-- No Postgres, valores NULL são distintos entre si, então lançamentos
-- criados na mão (sem external_id) não conflitam.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_id VARCHAR(80);

CREATE UNIQUE INDEX IF NOT EXISTS transactions_user_external_id_key
  ON transactions (user_id, external_id);
