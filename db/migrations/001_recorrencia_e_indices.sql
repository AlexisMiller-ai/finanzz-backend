-- Aditiva e idempotente: pode rodar mais de uma vez e é compatível com o código antigo.

-- Lançamentos recorrentes (ex.: aluguel, salário, assinaturas) compartilham um id de série.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recurrence_id UUID;

-- Consultas por usuário + período são as mais comuns do sistema.
CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions (user_id, date);
CREATE INDEX IF NOT EXISTS idx_transactions_installment_group ON transactions (installment_group_id) WHERE installment_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_recurrence ON transactions (recurrence_id) WHERE recurrence_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions (category_id);
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories (user_id);
CREATE INDEX IF NOT EXISTS idx_budgets_user_month ON budgets (user_id, month_ref);
