-- Ajuste manual do valor em aberto do cartão.
-- Serve para quem começou a usar o app com faturas antigas já pagas, ou que
-- reorganizou lançamentos entre cartões: em vez de registrar um pagamento para
-- cada fatura passada, diz quanto realmente deve hoje.

ALTER TABLE cards ADD COLUMN IF NOT EXISTS outstanding_adjustment NUMERIC(10, 2) NOT NULL DEFAULT 0;
