import { Response } from "express";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";

export const getCategories = async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      "SELECT * FROM categories WHERE user_id = $1 ORDER BY id",
      [req.userId],
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao buscar categorias" });
  }
};

export const createCategory = async (req: AuthRequest, res: Response) => {
  const { name, type, color } = req.body;

  if (!name || !type || !color) {
    return res
      .status(400)
      .json({
        status: "error",
        message: "Campos obrigatórios: name, type, color",
      });
  }

  try {
    const result = await pool.query(
      "INSERT INTO categories (name, type, color, user_id) VALUES ($1, $2, $3, $4) RETURNING *",
      [name, type, color, req.userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao criar categoria" });
  }
};

export const deleteCategory = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM categories WHERE id = $1 AND user_id = $2", [
      id,
      req.userId,
    ]);
    res.status(204).send();
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao excluir categoria" });
  }
};
