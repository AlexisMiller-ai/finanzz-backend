import { Response } from "express";
import { PoolClient } from "pg";
import { pool, withTransaction } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import {
  addMonths,
  centsToDecimal,
  parseDate,
  parseMonth,
  sendError,
  toCents,
  todayInBrazil,
} from "../utils/validation";

const INVALID_MONTH = 'Parâmetro "month" é obrigatório (ex: 2026-06)';

/**
 * Orçamento recorrente: uma linha em `budgets` diz "a partir deste mês, o
 * limite desta categoria é X". Ela vale para os meses seguintes até aparecer
 * outra linha da mesma categoria. `active = false` encerra o orçamento a
 * partir daquele mês sem apagar o histórico.
 */

type Scope = "daqui_pra_frente" | "so_este_mes";

const parseScope = (value: unknown): Scope =>
  value === "so_este_mes" ? "so_este_mes" : "daqui_pra_frente";

/** Aceita "2026-06" ou "2026-06-01" e devolve o primeiro dia do mês. */
function monthRefFrom(value: unknown): string | null {
  if (typeof value === "string" && value.length === 7) return parseMonth(value);
  const date = parseDate(value);
  return date ? `${date.slice(0, 7)}-01` : null;
}

/** Orçamento em vigor em cada categoria no mês $2 (a linha mais recente até ele). */
const VIGENTE_SQL = `
  SELECT DISTINCT ON (b.category_id) b.id, b.category_id, b.limit_amount, b.month_ref, b.active
    FROM budgets b
   WHERE b.user_id = $1 AND b.month_ref <= $2::date
   ORDER BY b.category_id, b.month_ref DESC`;

const gastoDaCategoria = (inicio: string, fim: string) => `COALESCE((
    SELECT SUM(t.amount) FROM transactions t
     WHERE t.user_id = $1 AND t.category_id = v.category_id
       AND t.type = 'despesa' AND t.transfer_id IS NULL
       AND t.date >= ${inicio} AND t.date < ${fim}
  ), 0)`;

/** Fração do mês que já passou: 1 para meses fechados, 0 para meses futuros. */
function fracaoDoMes(monthStart: string, hoje: string) {
  const mes = monthStart.slice(0, 7);
  const atual = hoje.slice(0, 7);
  if (mes < atual) return 1;
  if (mes > atual) return 0;
  const [ano = 1970, mesNum = 1] = mes.split("-").map(Number);
  const diasNoMes = new Date(Date.UTC(ano, mesNum, 0)).getUTCDate();
  return Number(hoje.slice(8, 10)) / diasNoMes;
}

export const getBudgets = async (req: AuthRequest, res: Response) => {
  const monthStart = parseMonth(req.query.month);
  if (!monthStart) return sendError(res, 400, INVALID_MONTH);

  try {
    const result = await pool.query(
      `WITH vigente AS (${VIGENTE_SQL})
       SELECT v.id, v.category_id, c.name AS category_name, c.color, v.limit_amount,
              to_char(v.month_ref, 'YYYY-MM') AS since,
              ${gastoDaCategoria("$2::date", "($2::date + INTERVAL '1 month')")} AS spent,
              ${gastoDaCategoria("($2::date - INTERVAL '3 months')", "$2::date")} / 3 AS average
         FROM vigente v
         JOIN categories c ON c.id = v.category_id AND c.user_id = $1
        WHERE v.active
        ORDER BY c.name`,
      [req.userId, monthStart],
    );

    const fracao = fracaoDoMes(monthStart, todayInBrazil());
    const mes = monthStart.slice(0, 7);

    const budgets = result.rows.map((row) => {
      const limit = parseFloat(row.limit_amount);
      const spent = parseFloat(row.spent);
      const percentageUsed = limit > 0 ? Math.round((spent / limit) * 100) : 0;
      // Só faz sentido projetar o mês corrente; nos outros, o gasto é o que é.
      const projection =
        fracao > 0 && fracao < 1 ? Math.round((spent / fracao) * 100) / 100 : spent;
      const pace =
        spent > limit
          ? "estourou"
          : projection > limit
            ? "vai_estourar"
            : percentageUsed >= 80
              ? "atencao"
              : "ok";
      return {
        id: row.id,
        categoryId: row.category_id,
        categoryName: row.category_name,
        color: row.color,
        limitAmount: limit,
        spent,
        remaining: Math.round((limit - spent) * 100) / 100,
        percentageUsed,
        since: row.since,
        inherited: row.since < mes,
        average: Math.round(parseFloat(row.average) * 100) / 100,
        projection,
        pace,
      };
    });

    res.json(budgets);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao buscar orçamentos");
  }
};

/**
 * Antes de mexer só no mês M, garante que M+1 continue com o que valia antes —
 * senão a mudança "vazaria" para os meses seguintes.
 */
async function preservarMesSeguinte(
  client: PoolClient,
  userId: number | undefined,
  categoryId: number,
  monthRef: string,
) {
  const seguinte = addMonths(monthRef, 1);
  const jaExiste = await client.query(
    "SELECT 1 FROM budgets WHERE user_id = $1 AND category_id = $2 AND month_ref = $3",
    [userId, categoryId, seguinte],
  );
  if (jaExiste.rows.length > 0) return;

  const antes = await client.query(
    `SELECT limit_amount, active FROM budgets
      WHERE user_id = $1 AND category_id = $2 AND month_ref <= $3
      ORDER BY month_ref DESC LIMIT 1`,
    [userId, categoryId, monthRef],
  );
  const linha = antes.rows[0];
  await client.query(
    `INSERT INTO budgets (category_id, month_ref, limit_amount, user_id, active)
     VALUES ($1, $2, $3, $4, $5)`,
    [categoryId, seguinte, linha ? linha.limit_amount : 0, userId, linha ? linha.active : false],
  );
}

async function categoriaDeDespesa(categoryId: number, userId: number | undefined) {
  const category = await pool.query(
    "SELECT type FROM categories WHERE id = $1 AND user_id = $2",
    [categoryId, userId],
  );
  if (!category.rows[0]) return "nao_encontrada";
  if (category.rows[0].type !== "despesa") return "nao_e_despesa";
  return "ok";
}

/**
 * Define o limite de uma categoria a partir do mês informado. Com
 * scope = so_este_mes, os meses seguintes continuam como estavam.
 */
export const createBudget = async (req: AuthRequest, res: Response) => {
  const { category_id, month_ref, limit_amount } = req.body ?? {};
  const monthRef = monthRefFrom(month_ref);
  const cents = toCents(limit_amount);
  const scope = parseScope(req.body?.scope);
  const categoryId = Number(category_id);

  if (!Number.isInteger(categoryId) || !monthRef || cents === null) {
    return sendError(res, 400, "Informe categoria, mês e um limite maior que zero");
  }

  try {
    const situacao = await categoriaDeDespesa(categoryId, req.userId);
    if (situacao === "nao_encontrada") return sendError(res, 404, "Categoria não encontrada");
    if (situacao === "nao_e_despesa") {
      return sendError(res, 400, "Orçamentos só podem ser definidos para despesas");
    }

    const saved = await withTransaction(async (client) => {
      if (scope === "so_este_mes") {
        await preservarMesSeguinte(client, req.userId, categoryId, monthRef);
      }
      const result = await client.query(
        `INSERT INTO budgets (category_id, month_ref, limit_amount, user_id, active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (category_id, month_ref)
         DO UPDATE SET limit_amount = EXCLUDED.limit_amount, active = true
         WHERE budgets.user_id = EXCLUDED.user_id
         RETURNING *`,
        [categoryId, monthRef, centsToDecimal(cents), req.userId],
      );
      return result.rows[0];
    });
    res.status(201).json({ ...saved, scope });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao salvar orçamento");
  }
};

/**
 * Encerra o orçamento da categoria a partir do mês (ou só naquele mês, com
 * scope = so_este_mes). Os meses anteriores mantêm o histórico.
 */
export const stopBudget = async (req: AuthRequest, res: Response) => {
  const categoryId = Number(req.params.categoryId);
  const monthRef = parseMonth(req.query.month);
  const scope = parseScope(req.query.scope);
  if (!Number.isInteger(categoryId)) return sendError(res, 400, "Categoria inválida");
  if (!monthRef) return sendError(res, 400, INVALID_MONTH);

  try {
    const situacao = await categoriaDeDespesa(categoryId, req.userId);
    if (situacao === "nao_encontrada") return sendError(res, 404, "Categoria não encontrada");

    await withTransaction(async (client) => {
      if (scope === "so_este_mes") {
        await preservarMesSeguinte(client, req.userId, categoryId, monthRef);
      }
      await client.query(
        `INSERT INTO budgets (category_id, month_ref, limit_amount, user_id, active)
         VALUES ($1, $2, 0, $3, false)
         ON CONFLICT (category_id, month_ref)
         DO UPDATE SET active = false
         WHERE budgets.user_id = EXCLUDED.user_id`,
        [categoryId, monthRef, req.userId],
      );
    });
    res.status(204).send();
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao encerrar orçamento");
  }
};

/**
 * Sugestões de limite para categorias com gasto e sem orçamento: a média dos
 * três meses anteriores, arredondada para cima de 50 em 50.
 */
export const getSuggestions = async (req: AuthRequest, res: Response) => {
  const monthStart = parseMonth(req.query.month);
  if (!monthStart) return sendError(res, 400, INVALID_MONTH);

  try {
    const result = await pool.query(
      `WITH vigente AS (${VIGENTE_SQL}),
       media AS (
         SELECT t.category_id,
                SUM(t.amount) / 3 AS media,
                COUNT(DISTINCT date_trunc('month', t.date))::int AS meses
           FROM transactions t
          WHERE t.user_id = $1 AND t.type = 'despesa' AND t.transfer_id IS NULL
            AND t.category_id IS NOT NULL
            AND t.date >= ($2::date - INTERVAL '3 months') AND t.date < $2::date
          GROUP BY t.category_id
       )
       SELECT m.category_id, c.name, c.color, m.media, m.meses
         FROM media m
         JOIN categories c ON c.id = m.category_id AND c.user_id = $1 AND c.type = 'despesa'
        WHERE NOT EXISTS (
          SELECT 1 FROM vigente v WHERE v.category_id = m.category_id AND v.active
        )
        ORDER BY m.media DESC
        LIMIT 8`,
      [req.userId, monthStart],
    );

    res.json(
      result.rows.map((row) => {
        const media = Math.round(parseFloat(row.media) * 100) / 100;
        return {
          categoryId: row.category_id,
          categoryName: row.name,
          color: row.color,
          average: media,
          monthsWithSpending: row.meses,
          suggested: Math.max(50, Math.ceil(media / 50) * 50),
        };
      }),
    );
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao sugerir orçamentos");
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
       WHERE b.user_id = $3 AND b.month_ref = $1::date AND b.active
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
