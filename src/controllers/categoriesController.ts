import { Response } from "express";
import { pool, withTransaction } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import {
  TRANSACTION_TYPES,
  cleanText,
  isOneOf,
  isValidHexColor,
  sendError,
} from "../utils/validation";

export const getCategories = async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.type, c.color,
              (SELECT COUNT(*)::int FROM transactions t WHERE t.category_id = c.id AND t.user_id = $1) AS transaction_count
       FROM categories c
       WHERE c.user_id = $1
       ORDER BY c.type, LOWER(c.name)`,
      [req.userId],
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao buscar categorias");
  }
};

async function nameTaken(
  userId: number | undefined,
  name: string,
  type: string,
  ignoreId?: number,
) {
  const result = await pool.query(
    `SELECT id FROM categories
     WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND type = $3 AND id <> $4`,
    [userId, name, type, ignoreId ?? 0],
  );
  return result.rows.length > 0;
}

export const createCategory = async (req: AuthRequest, res: Response) => {
  const name = cleanText(req.body?.name, 50);
  const { type, color } = req.body ?? {};

  if (!name || !isOneOf(TRANSACTION_TYPES, type) || !isValidHexColor(color)) {
    return sendError(res, 400, "Informe nome, tipo (despesa/receita) e cor");
  }

  try {
    if (await nameTaken(req.userId, name, type)) {
      return sendError(res, 409, "Já existe uma categoria com esse nome");
    }
    const result = await pool.query(
      `INSERT INTO categories (name, type, color, user_id) VALUES ($1, $2, $3, $4)
       RETURNING id, name, type, color, 0 AS transaction_count`,
      [name, type, color, req.userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao criar categoria");
  }
};

export const updateCategory = async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const name = cleanText(req.body?.name, 50);
  const { type, color } = req.body ?? {};

  if (!name || !isOneOf(TRANSACTION_TYPES, type) || !isValidHexColor(color)) {
    return sendError(res, 400, "Informe nome, tipo (despesa/receita) e cor");
  }

  try {
    const current = await pool.query(
      `SELECT c.type,
              (SELECT COUNT(*)::int FROM transactions t WHERE t.category_id = c.id) AS transaction_count
       FROM categories c WHERE c.id = $1 AND c.user_id = $2`,
      [id, req.userId],
    );
    const category = current.rows[0];
    if (!category) {
      return sendError(res, 404, "Categoria não encontrada");
    }
    if (category.type !== type && category.transaction_count > 0) {
      return sendError(
        res,
        400,
        "Não é possível mudar o tipo de uma categoria que já tem lançamentos",
      );
    }
    if (await nameTaken(req.userId, name, type, id)) {
      return sendError(res, 409, "Já existe uma categoria com esse nome");
    }

    const result = await pool.query(
      `UPDATE categories SET name = $1, type = $2, color = $3
       WHERE id = $4 AND user_id = $5
       RETURNING id, name, type, color`,
      [name, type, color, id, req.userId],
    );
    res.json({ ...result.rows[0], transaction_count: category.transaction_count });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao atualizar categoria");
  }
};

export const deleteCategory = async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);

  try {
    // Antes, excluir uma categoria em uso quebrava por causa da chave estrangeira.
    // Agora os lançamentos ficam "sem categoria" e os orçamentos dela são removidos.
    const deleted = await withTransaction(async (client) => {
      const owned = await client.query(
        "SELECT id FROM categories WHERE id = $1 AND user_id = $2",
        [id, req.userId],
      );
      if (owned.rows.length === 0) return false;

      await client.query(
        "UPDATE transactions SET category_id = NULL WHERE category_id = $1 AND user_id = $2",
        [id, req.userId],
      );
      await client.query(
        "DELETE FROM budgets WHERE category_id = $1 AND user_id = $2",
        [id, req.userId],
      );
      await client.query(
        "DELETE FROM categories WHERE id = $1 AND user_id = $2",
        [id, req.userId],
      );
      return true;
    });

    if (!deleted) {
      return sendError(res, 404, "Categoria não encontrada");
    }
    res.status(204).send();
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao excluir categoria");
  }
};
