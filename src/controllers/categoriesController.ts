import { Request, Response } from "express";
import { pool } from "../config/db";

export const getCategories = async (req: Request, res: Response) => {
  try {
    const result = await pool.query("SELECT * FROM categories ORDER BY id");
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao buscar categorias" });
  }
};

export const createCategory = async (req: Request, res: Response) => {
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
      "INSERT INTO categories (name, type, color) VALUES ($1, $2, $3) RETURNING *",
      [name, type, color],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao criar categoria" });
  }
};

export const deleteCategory = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM categories WHERE id = $1", [id]);
    res.status(204).send();
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao excluir categoria" });
  }
};
