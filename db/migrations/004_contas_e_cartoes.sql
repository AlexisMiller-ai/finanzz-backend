-- Contas (onde o dinheiro fica) e cartões de crédito (onde a dívida se acumula).
-- Idempotente: pode rodar de novo sem duplicar nada.

CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name VARCHAR(50) NOT NULL,
  kind VARCHAR(12) NOT NULL DEFAULT 'corrente'
    CHECK (kind IN ('corrente', 'poupanca', 'dinheiro', 'investimento')),
  color VARCHAR(7) NOT NULL DEFAULT '#7C3AED',
  initial_balance NUMERIC(10, 2) NOT NULL DEFAULT 0,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cards (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name VARCHAR(50) NOT NULL,
  color VARCHAR(7) NOT NULL DEFAULT '#7C3AED',
  closing_day SMALLINT CHECK (closing_day BETWEEN 1 AND 31),
  due_day SMALLINT CHECK (due_day BETWEEN 1 AND 31),
  limit_amount NUMERIC(10, 2),
  payment_account_id INTEGER REFERENCES accounts(id),
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP DEFAULT now()
);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS account_id INTEGER REFERENCES accounts(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS card_id INTEGER REFERENCES cards(id);
-- As duas pontas de uma transferência compartilham este id e ficam fora dos
-- totais de entradas e saídas (dinheiro trocando de lugar não é receita nem despesa).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_id UUID;

CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions (account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_card ON transactions (card_id);
CREATE INDEX IF NOT EXISTS idx_transactions_transfer ON transactions (transfer_id) WHERE transfer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_cards_user ON cards (user_id);

-- Um lançamento fica ou numa conta ou num cartão, nunca nos dois.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_account_or_card;
ALTER TABLE transactions ADD CONSTRAINT transactions_account_or_card
  CHECK (account_id IS NULL OR card_id IS NULL);

-- Conta e cartão padrão para quem já usava o sistema, para nenhum lançamento
-- antigo ficar sem classificação.
INSERT INTO accounts (user_id, name, kind)
SELECT u.id, 'Conta principal', 'corrente'
  FROM users u
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id);

INSERT INTO cards (user_id, name)
SELECT u.id, 'Cartão de crédito'
  FROM users u
 WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.user_id = u.id)
   AND EXISTS (
     SELECT 1 FROM transactions t
      WHERE t.user_id = u.id AND t.payment_method = 'credito' AND t.type = 'despesa'
   );

-- Despesas no crédito vão para o cartão; todo o resto, para a conta.
UPDATE transactions t
   SET card_id = c.id
  FROM cards c
 WHERE c.user_id = t.user_id
   AND t.card_id IS NULL AND t.account_id IS NULL
   AND t.payment_method = 'credito' AND t.type = 'despesa'
   AND c.id = (SELECT MIN(id) FROM cards WHERE user_id = t.user_id);

UPDATE transactions t
   SET account_id = a.id
  FROM accounts a
 WHERE a.user_id = t.user_id
   AND t.card_id IS NULL AND t.account_id IS NULL
   AND a.id = (SELECT MIN(id) FROM accounts WHERE user_id = t.user_id);
