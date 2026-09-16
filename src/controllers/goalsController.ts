import { Response } from "express";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { parseDate, parseMonth, sendError } from "../utils/validation";

export const getGoal = async (req: AuthRequest, res: Response) => {
  const monthStart = parseMonth(req.query.month);
  if (!monthStart) {
    return sendError(res, 400, 'Parâmetro "month" é obrigatório (ex: 2026-06)');
  }

  try {
    const result = await pool.query(
      "SELECT savings_goal FROM monthly_goals WHERE user_id = $1 AND month_ref = $2::date",
      [req.userId, monthStart],
    );
    const savingsGoal = result.rows[0] ? parseFloat(result.rows[0].savings_goal) : 0;
    res.json({ savingsGoal });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao buscar meta");
  }
};

/** Define a meta de economia do mês. Enviar 0 remove a meta. */
export const setGoal = async (req: AuthRequest, res: Response) => {
  const date = parseDate(req.body?.month_ref);
  const goal = Number(req.body?.savings_goal);

  if (!date || !Number.isFinite(goal) || goal < 0 || goal >= 1e8) {
    return sendError(res, 400, "Informe o mês e uma meta válida");
  }
  const monthRef = `${date.slice(0, 7)}-01`;

  try {
    if (goal === 0) {
      await pool.query(
        "DELETE FROM monthly_goals WHERE user_id = $1 AND month_ref = $2::date",
        [req.userId, monthRef],
      );
      return res.json({ savings_goal: 0 });
    }

    const result = await pool.query(
      `INSERT INTO monthly_goals (user_id, month_ref, savings_goal)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, month_ref)
       DO UPDATE SET savings_goal = EXCLUDED.savings_goal
       RETURNING *`,
      [req.userId, monthRef, goal.toFixed(2)],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao salvar meta");
  }
};
