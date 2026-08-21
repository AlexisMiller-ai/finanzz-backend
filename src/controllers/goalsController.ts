import { Response } from "express";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";

export const getGoal = async (req: AuthRequest, res: Response) => {
  const { month } = req.query;

  if (!month) {
    return res
      .status(400)
      .json({
        status: "error",
        message: 'Parâmetro "month" é obrigatório (ex: 2026-06)',
      });
  }

  try {
    const result = await pool.query(
      "SELECT savings_goal FROM monthly_goals WHERE user_id = $1 AND month_ref = $2::date",
      [req.userId, `${month}-01`],
    );
    const savingsGoal = result.rows[0]
      ? parseFloat(result.rows[0].savings_goal)
      : 0;
    res.json({ savingsGoal });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "error", message: "Erro ao buscar meta" });
  }
};

export const setGoal = async (req: AuthRequest, res: Response) => {
  const { month_ref, savings_goal } = req.body;

  if (!month_ref || savings_goal === undefined) {
    return res
      .status(400)
      .json({
        status: "error",
        message: "Campos obrigatórios: month_ref, savings_goal",
      });
  }

  try {
    const result = await pool.query(
      `INSERT INTO monthly_goals (user_id, month_ref, savings_goal)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, month_ref)
       DO UPDATE SET savings_goal = $3
       RETURNING *`,
      [req.userId, month_ref, savings_goal],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "error", message: "Erro ao salvar meta" });
  }
};
