import { pool } from "../config/db";
import { todayInBrazil } from "../utils/validation";

/** O total guardado considera lançamentos a partir desta data. */
export const SAVINGS_START_DATE = "2026-08-01";

/**
 * Saldo calculado automaticamente: entradas - saídas desde SAVINGS_START_DATE até hoje.
 * Lançamentos com data futura (próximas parcelas, faturas e recorrências) só entram
 * quando a data chegar; antes eles já abatiam o total no dia em que eram cadastrados.
 */
export async function getCalculatedSavings(userId: number | undefined) {
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'receita' THEN amount ELSE -amount END), 0) AS total
     FROM transactions
     WHERE user_id = $1 AND date >= $2::date AND date <= $3::date`,
    [userId, SAVINGS_START_DATE, todayInBrazil()],
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
