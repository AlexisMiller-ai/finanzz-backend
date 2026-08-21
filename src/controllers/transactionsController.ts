import { Response } from "express";
import crypto from "crypto";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";

function addMonths(dateStr: string, months: number): string {
  const parts = dateStr.split("-").map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  const newYear = date.getUTCFullYear();
  const newMonth = String(date.getUTCMonth() + 1).padStart(2, "0");
  const newDay = String(date.getUTCDate()).padStart(2, "0");
  return `${newYear}-${newMonth}-${newDay}`;
}

export const getTransactions = async (req: AuthRequest, res: Response) => {
  const { month } = req.query;

  try {
    let query = "SELECT * FROM transactions WHERE user_id = $1";
    const params: any[] = [req.userId];

    if (month) {
      query += ` AND date >= $2::date AND date < ($2::date + INTERVAL '1 month')`;
      params.push(`${month}-01`);
    }

    query += " ORDER BY date DESC, id DESC";

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao buscar lançamentos" });
  }
};

export const createTransaction = async (req: AuthRequest, res: Response) => {
  const {
    amount,
    type,
    category_id,
    description,
    date,
    purchase_date,
    payment_method,
    is_installment,
    installments,
  } = req.body;

  if (!amount || !type || !date) {
    return res.status(400).json({
      status: "error",
      message: "Campos obrigatórios: amount, type, date",
    });
  }

  try {
    // Fluxo de compra parcelada
    if (is_installment && installments && Number(installments) > 1) {
      const total = parseFloat(amount);
      const count = parseInt(installments, 10);
      const baseValue = Math.floor((total / count) * 100) / 100;
      const roundedSum = baseValue * count;
      const remainder = Math.round((total - roundedSum) * 100) / 100;

      const groupId = crypto.randomUUID();
      const createdRows = [];

      for (let i = 1; i <= count; i++) {
        const installmentAmount =
          i === count ? baseValue + remainder : baseValue;
        const installmentDate = addMonths(date, i - 1);
        const installmentDescription = description
          ? `${description} (${i}/${count})`
          : `(${i}/${count})`;

        const result = await pool.query(
          `INSERT INTO transactions
            (amount, type, category_id, description, date, purchase_date, payment_method, user_id, installment_group_id, installment_number, installment_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            installmentAmount,
            type,
            category_id || null,
            installmentDescription,
            installmentDate,
            purchase_date || date,
            payment_method || "dinheiro",
            req.userId,
            groupId,
            i,
            count,
          ],
        );
        createdRows.push(result.rows[0]);
      }

      return res.status(201).json({ installments: createdRows });
    }

    // Fluxo normal (sem parcelamento)
    const result = await pool.query(
      `INSERT INTO transactions (amount, type, category_id, description, date, purchase_date, payment_method, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        amount,
        type,
        category_id || null,
        description || null,
        date,
        purchase_date || date,
        payment_method || "dinheiro",
        req.userId,
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao criar lançamento" });
  }
};

export const updateTransaction = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const {
    amount,
    type,
    category_id,
    description,
    date,
    purchase_date,
    payment_method,
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE transactions
       SET amount = $1, type = $2, category_id = $3, description = $4, date = $5,
           purchase_date = $6, payment_method = $7
       WHERE id = $8 AND user_id = $9 RETURNING *`,
      [
        amount,
        type,
        category_id || null,
        description || null,
        date,
        purchase_date || date,
        payment_method || "dinheiro",
        id,
        req.userId,
      ],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Lançamento não encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao atualizar lançamento" });
  }
};

export const deleteTransaction = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  try {
    await pool.query(
      "DELETE FROM transactions WHERE id = $1 AND user_id = $2",
      [id, req.userId],
    );
    res.status(204).send();
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao excluir lançamento" });
  }
};

export const deleteInstallmentGroup = async (
  req: AuthRequest,
  res: Response,
) => {
  const { groupId } = req.params;

  try {
    await pool.query(
      "DELETE FROM transactions WHERE installment_group_id = $1 AND user_id = $2",
      [groupId, req.userId],
    );
    res.status(204).send();
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao excluir parcelamento" });
  }
};
