-- Contas a pagar e a receber.
--
-- Até aqui todo lançamento era tratado como já efetivado assim que a data
-- chegava: a conta de luz lançada para o dia 10 saía do saldo no dia 10,
-- tivesse sido paga ou não. Agora o lançamento carrega a situação.
--
-- settled = true  -> pago (despesa) ou recebido (receita); entra no saldo
-- settled = false -> pendente; aparece em "a pagar / a receber" e fica fora
--                    do saldo e do total guardado até receber baixa
--
-- Tudo que já existe entra como efetivado, para nenhum número mudar sozinho.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settled BOOLEAN NOT NULL DEFAULT true;
-- Dia em que foi pago/recebido de verdade, quando diferente da data prevista.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settled_at DATE;

-- Lançamento de cartão não tem pendência própria: quem é paga é a fatura
-- (card_bills). Transferência também não: o dinheiro já mudou de lugar.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_pendencia;
ALTER TABLE transactions ADD CONSTRAINT transactions_pendencia
  CHECK (settled OR (card_id IS NULL AND transfer_id IS NULL));

CREATE INDEX IF NOT EXISTS idx_transactions_pendentes
  ON transactions (user_id, date) WHERE NOT settled;
