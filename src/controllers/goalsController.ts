import { Response } from "express";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { getSavingsGoal } from "../services/plan";
import { parseDate, parseMonth, sendError } from "../utils/validation";

export const getGoal = async (req: AuthRequest, res: Response) => {
  const monthStart = parseMonth(req.query.month);
  if (!monthStart) {
    return sendError(res, 400, 'Parâmetro "month" é obrigatório (ex: 2026-06)');
  }

  try {
    const { goal, fromMonth } = await getSavingsGoal(req.userId, monthStart);
    res.json({ savingsGoal: goal, fromMonth });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao buscar meta");
  }
};

/**
 * Define a meta de economia a partir do mês informado: ela vale para os meses
 * seguintes até ser mudada. Enviar 0 encerra a meta a partir daquele mês.
 */
export const setGoal = async (req: AuthRequest, res: Response) => {
  const date = parseDate(req.body?.month_ref);
  const goal = Number(req.body?.savings_goal);

  if (!date || !Number.isFinite(goal) || goal < 0 || goal >= 1e8) {
    return sendError(res, 400, "Informe o mês e uma meta válida");
  }
  const monthRef = `${date.slice(0, 7)}-01`;

  try {
    // Guarda inclusive o 0: é ele que encerra a meta dali em diante, sem
    // apagar o histórico nem fazer a meta antiga voltar a valer.
    const result = await pool.query(
      `INSERT INTO monthly_goals (user_id, month_ref, savings_goal)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, month_ref)
       DO UPDATE SET savings_goal = EXCLUDED.savings_goal
       RETURNING month_ref, savings_goal`,
      [req.userId, monthRef, goal.toFixed(2)],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao salvar meta");
  }
};
