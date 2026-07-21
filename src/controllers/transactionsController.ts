import { Response } from "express";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";

export const getTransactions = async (req: AuthRequest, res: Response) => {
  const { month } = req.query;

  console.log("DEBUG userId:", req.userId, typeof req.userId); // linha temporária

  try {
    let query = "SELECT * FROM transactions WHERE user_id = $1";
    const params: any[] = [req.userId];

    if (month) {
      query += ` AND date >= $2::date AND date < ($2::date + INTERVAL '1 month')`;
      params.push(`${month}-01`);
    }

    query += " ORDER BY date DESC, id DESC";

    console.log("DEBUG query:", query, params); // linha temporária

    const result = await pool.query(query, params);

    console.log("DEBUG resultado:", result.rows.length, "linhas"); // linha temporária

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
  } = req.body;

  if (!amount || !type || !date) {
    return res
      .status(400)
      .json({
        status: "error",
        message: "Campos obrigatórios: amount, type, date",
      });
  }

  try {
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
