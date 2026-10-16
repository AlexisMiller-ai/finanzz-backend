import { pool } from "../config/db";

export interface SavingsGoal {
  /** Quanto o usuário quer guardar no mês. 0 = sem meta. */
  goal: number;
  /** Mês em que essa meta foi definida ("YYYY-MM-01"), ou null se não há meta. */
  fromMonth: string | null;
}

/**
 * Meta de economia valendo no mês pedido.
 * Igual aos orçamentos: a meta definida num mês continua valendo nos seguintes
 * até existir outra — quem guarda sempre o mesmo valor define uma vez só.
 * Uma linha com 0 significa "sem meta a partir daqui".
 */
export async function getSavingsGoal(
  userId: number | undefined,
  monthStart: string,
): Promise<SavingsGoal> {
  const result = await pool.query(
    `SELECT month_ref, savings_goal
       FROM monthly_goals
      WHERE user_id = $1 AND month_ref <= $2::date
      ORDER BY month_ref DESC
      LIMIT 1`,
    [userId, monthStart],
  );

  const row = result.rows[0];
  if (!row) return { goal: 0, fromMonth: null };

  const goal = parseFloat(row.savings_goal);
  return { goal, fromMonth: goal > 0 ? String(row.month_ref).slice(0, 10) : null };
}
