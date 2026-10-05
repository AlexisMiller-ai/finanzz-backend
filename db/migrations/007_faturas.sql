-- Faturas de cartão: registro de quais faturas já foram pagas.
--
-- Até aqui o sistema somava tudo que estava lançado no cartão e chamava de
-- "em aberto". Faturas de meses que já fecharam e foram pagas continuavam
-- aparecendo como dívida. Agora cada fatura (mês de referência) pode ser
-- marcada como paga, e o mês de fechamento do cartão define qual fatura ainda
-- está aberta.
--
-- kind diz o que fazer com o valor no cálculo do que o cartão deve hoje:
--   transferencia -> o pagamento virou uma transferência conta -> cartão
--                    (o lançamento já abate a dívida; não abater de novo)
--   externo       -> pago fora do app, sem lançamento (abater aqui)
--   lancado       -> o pagamento já estava lançado à mão no app (não abater)

CREATE TABLE IF NOT EXISTS card_bills (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  card_id INTEGER NOT NULL REFERENCES cards(id),
  bill_month DATE NOT NULL CHECK (EXTRACT(DAY FROM bill_month) = 1),
  amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  paid_date DATE NOT NULL,
  kind VARCHAR(14) NOT NULL DEFAULT 'externo'
    CHECK (kind IN ('transferencia', 'externo', 'lancado')),
  transfer_id UUID,
  created_at TIMESTAMP DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS card_bills_card_month_key ON card_bills (card_id, bill_month);
CREATE INDEX IF NOT EXISTS idx_card_bills_user ON card_bills (user_id);
