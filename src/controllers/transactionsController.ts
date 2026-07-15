import { Request, Response } from "express";
import { pool } from "../config/db";

export const getTransactions = async (req: Request, res: Response) => {
  const { month } = req.query; // formato esperado: "2026-06"

  try {
    let query = "SELECT * FROM transactions";
    const params: any[] = [];

    if (month) {
      query += ` WHERE date >= $1 AND date < ($1::date + INTERVAL '1 month')`;
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

export const createTransaction = async (req: Request, res: Response) => {
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
      `INSERT INTO transactions (amount, type, category_id, description, date, purchase_date, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        amount,
        type,
        category_id || null,
        description || null,
        date,
        purchase_date || date,
        payment_method || "dinheiro",
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

export const updateTransaction = async (req: Request, res: Response) => {
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
       WHERE id = $8 RETURNING *`,
      [
        amount,
        type,
        category_id || null,
        description || null,
        date,
        purchase_date || date,
        payment_method || "dinheiro",
        id,
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

export const deleteTransaction = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM transactions WHERE id = $1", [id]);
    res.status(204).send();
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao excluir lançamento" });
  }
};
