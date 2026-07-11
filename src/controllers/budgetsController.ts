import { Request, Response } from "express";
import { pool } from "../config/db";

export const getBudgets = async (req: Request, res: Response) => {
  const { month } = req.query; // formato esperado: "2026-06"

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
      `SELECT
        b.id,
        b.category_id,
        c.name AS category_name,
        c.color,
        b.month_ref,
        b.limit_amount,
        COALESCE(SUM(t.amount), 0) AS gasto_atual
       FROM budgets b
       JOIN categories c ON c.id = b.category_id
       LEFT JOIN transactions t
         ON t.category_id = b.category_id
         AND t.type = 'despesa'
         AND t.date >= b.month_ref AND t.date < (b.month_ref + INTERVAL '1 month')
       WHERE b.month_ref = $1::date
       GROUP BY b.id, b.category_id, c.name, c.color, b.month_ref, b.limit_amount
       ORDER BY c.name`,
      [`${month}-01`],
    );

    const budgets = result.rows.map((row) => {
      const limite = parseFloat(row.limit_amount);
      const gasto = parseFloat(row.gasto_atual);
      return {
        id: row.id,
        categoryId: row.category_id,
        categoryName: row.category_name,
        color: row.color,
        limitAmount: limite,
        spent: gasto,
        remaining: limite - gasto,
        percentageUsed:
          limite > 0 ? parseFloat(((gasto / limite) * 100).toFixed(0)) : 0,
      };
    });

    res.json(budgets);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao buscar metas/orçamentos" });
  }
};

export const createBudget = async (req: Request, res: Response) => {
  const { category_id, month_ref, limit_amount } = req.body;

  if (!category_id || !month_ref || !limit_amount) {
    return res
      .status(400)
      .json({
        status: "error",
        message: "Campos obrigatórios: category_id, month_ref, limit_amount",
      });
  }

  try {
    const result = await pool.query(
      `INSERT INTO budgets (category_id, month_ref, limit_amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (category_id, month_ref)
       DO UPDATE SET limit_amount = $3
       RETURNING *`,
      [category_id, month_ref, limit_amount],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao criar meta/orçamento" });
  }
};

export const deleteBudget = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM budgets WHERE id = $1", [id]);
    res.status(204).send();
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao excluir meta/orçamento" });
  }
};
