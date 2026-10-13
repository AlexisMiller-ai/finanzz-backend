-- Orçamento recorrente.
--
-- Antes cada orçamento valia só para o mês em que era criado, e todo mês
-- precisava ser refeito (ou copiado). Agora uma linha em `budgets` quer dizer
-- "a partir deste mês, o limite desta categoria é X" e vale para os meses
-- seguintes até aparecer outra linha da mesma categoria.
--
-- active = false encerra o orçamento a partir daquele mês, sem apagar o
-- histórico dos meses anteriores.

ALTER TABLE budgets ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_budgets_user_category_month
  ON budgets (user_id, category_id, month_ref DESC);
