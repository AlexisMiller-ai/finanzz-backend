-- Conta e cartão favoritos: vêm pré-selecionados no formulário, em qualquer
-- dispositivo. Índice parcial garante no máximo um favorito por usuário.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_one_default_per_user
  ON accounts (user_id) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS cards_one_default_per_user
  ON cards (user_id) WHERE is_default;
