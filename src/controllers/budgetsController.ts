import { Response } from "express";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import {
  centsToDecimal,
  parseDate,
  parseMonth,
  sendError,
  toCents,
} from "../utils/validation";

const INVALID_MONTH = 'Parâmetro "month" é obrigatório (ex: 2026-06)';

/** Aceita "2026-06" ou "2026-06-01" e devolve o primeiro dia do mês. */
function monthRefFrom(value: unknown): string | null {
  if (typeof value === "string" && value.length === 7) return parseMonth(value);
  const date = parseDate(value);
  return date ? `${date.slice(0, 7)}-01` : null;
}

export const getBudgets = async (req: AuthRequest, res: Response) => {
  const monthStart = parseMonth(req.query.month);
  if (!monthStart) return sendError(res, 400, INVALID_MONTH);

  try {
    const result = await pool.query(
      `SELECT
        b.id,
        b.category_id,
        c.name AS category_name,
        c.color,
        b.limit_amount,
        COALESCE((
          SELECT SUM(t.amount) FROM transactions t
          WHERE t.category_id = b.category_id
            AND t.type = 'despesa'
            AND t.user_id = $1
            AND t.date >= b.month_ref AND t.date < (b.month_ref + INTERVAL '1 month')
        ), 0) AS spent
       FROM budgets b
       JOIN categories c ON c.id = b.category_id
       WHERE b.month_ref = $2::date AND b.user_id = $1
       ORDER BY c.name`,
      [req.userId, monthStart],
    );

    const budgets = result.rows.map((row) => {
      const limit = parseFloat(row.limit_amount);
      const spent = parseFloat(row.spent);
      return {
        id: row.id,
        categoryId: row.category_id,
        categoryName: row.category_name,
        color: row.color,
        limitAmount: limit,
        spent,
        remaining: limit - spent,
        percentageUsed: limit > 0 ? Math.round((spent / limit) * 100) : 0,
      };
    });

    res.json(budgets);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao buscar orçamentos");
  }
};

/** Cria ou atualiza o limite de uma categoria no mês. */
export const createBudget = async (req: AuthRequest, res: Response) => {
  const { category_id, month_ref, limit_amount } = req.body ?? {};
  const monthRef = monthRefFrom(month_ref);
  const cents = toCents(limit_amount);

  if (!category_id || !monthRef || cents === null) {
    return sendError(res, 400, "Informe categoria, mês e um limite maior que zero");
  }

  try {
    const category = await pool.query(
      "SELECT type FROM categories WHERE id = $1 AND user_id = $2",
      [category_id, req.userId],
    );
    if (!category.rows[0]) return sendError(res, 404, "Categoria não encontrada");
    if (category.rows[0].type !== "despesa") {
      return sendError(res, 400, "Orçamentos só podem ser definidos para despesas");
    }

    const result = await pool.query(
      `INSERT INTO budgets (category_id, month_ref, limit_amount, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (category_id, month_ref)
       DO UPDATE SET limit_amount = EXCLUDED.limit_amount
       WHERE budgets.user_id = EXCLUDED.user_id
       RETURNING *`,
      [category_id, monthRef, centsToDecimal(cents), req.userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao salvar orçamento");
  }
};

/** Copia os orçamentos de um mês para outro, sem sobrescrever os já existentes. */
export const copyBudgets = async (req: AuthRequest, res: Response) => {
  const from = monthRefFrom(req.body?.from_month);
  const to = monthRefFrom(req.body?.to_month);
  if (!from || !to || from === to) {
    return sendError(res, 400, "Informe mês de origem e de destino diferentes");
  }

  try {
    const result = await pool.query(
      `INSERT INTO budgets (category_id, month_ref, limit_amount, user_id)
       SELECT b.category_id, $2::date, b.limit_amount, b.user_id
       FROM budgets b
       WHERE b.user_id = $3 AND b.month_ref = $1::date
       ON CONFLICT (category_id, month_ref) DO NOTHING`,
      [from, to, req.userId],
    );
    res.status(201).json({ copied: result.rowCount });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao copiar orçamentos");
  }
};

export const deleteBudget = async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      "DELETE FROM budgets WHERE id = $1 AND user_id = $2",
      [req.params.id, req.userId],
    );
    if (result.rowCount === 0) return sendError(res, 404, "Orçamento não encontrado");
    res.status(204).send();
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao excluir orçamento");
  }
};
