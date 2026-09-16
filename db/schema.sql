-- Schema base do Finanzz (estado do banco antes das migrations em db/migrations).
-- Para criar um banco do zero: rode este arquivo e depois `npm run migrate`.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  savings_adjustment NUMERIC(10, 2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('despesa', 'receita')),
  color VARCHAR(7) NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  user_id INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  amount NUMERIC(10, 2) NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('despesa', 'receita')),
  category_id INTEGER REFERENCES categories(id),
  description VARCHAR(255),
  date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  payment_method VARCHAR(10) NOT NULL DEFAULT 'dinheiro'
    CHECK (payment_method IN ('dinheiro', 'debito', 'credito')),
  purchase_date DATE,
  user_id INTEGER REFERENCES users(id),
  installment_group_id UUID,
  installment_number INTEGER,
  installment_total INTEGER
);

CREATE TABLE IF NOT EXISTS budgets (
  id SERIAL PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id),
  month_ref DATE NOT NULL,
  limit_amount NUMERIC(10, 2) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  UNIQUE (category_id, month_ref)
);

CREATE TABLE IF NOT EXISTS monthly_goals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  month_ref DATE NOT NULL,
  savings_goal NUMERIC(10, 2) NOT NULL,
  UNIQUE (user_id, month_ref)
);
