import { pool } from "../config/db";
import { todayInBrazil } from "../utils/validation";

/**
 * De quando o "Total guardado" começa a contar para o usuário: a data que ele
 * escolheu ou, sem escolha, o dia do primeiro lançamento. `escolhido` é null
 * quando vale o primeiro lançamento.
 */
export async function getSavingsStart(userId: number | undefined) {
  const result = await pool.query(
    `SELECT u.savings_start_date AS escolhido,
            (SELECT MIN(t.date) FROM transactions t
              WHERE t.user_id = u.id AND t.transfer_id IS NULL) AS primeiro
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  const row = result.rows[0] ?? {};
  const escolhido: string | null = row.escolhido ?? null;
  return { inicio: escolhido ?? row.primeiro ?? null, escolhido };
}

/**
 * Saldo calculado automaticamente: entradas - saídas desde o início da
 * contagem até hoje. Lançamentos com data futura (próximas parcelas, faturas
 * e recorrências) só entram quando a data chegar, e o que está pendente
 * (ainda não pago ou não recebido) também fica de fora.
 */
export async function getCalculatedSavings(userId: number | undefined) {
  const { inicio } = await getSavingsStart(userId);
  if (!inicio) return 0;
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'receita' THEN amount ELSE -amount END), 0) AS total
     FROM transactions
     WHERE user_id = $1 AND transfer_id IS NULL AND settled
       AND date >= $2::date AND date <= $3::date`,
    [userId, inicio, todayInBrazil()],
  );
  return parseFloat(result.rows[0].total);
}

export async function getSavingsAdjustment(userId: number | undefined) {
  const result = await pool.query(
    "SELECT savings_adjustment FROM users WHERE id = $1",
    [userId],
  );
  return parseFloat(result.rows[0]?.savings_adjustment ?? 0);
}
