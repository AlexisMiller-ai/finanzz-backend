import { Response } from "express";
import { pool, withTransaction } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import {
  centsToDecimal,
  cleanText,
  isValidHexColor,
  parseMonth,
  sendError,
  toCents,
} from "../utils/validation";

function parseDay(value: unknown): number | null {
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

/**
 * Cartões com o total da fatura do mês pedido e o saldo devedor acumulado
 * (tudo que foi gasto menos os pagamentos já lançados).
 */
export const getCards = async (req: AuthRequest, res: Response) => {
  const monthStart = req.query.month === undefined ? null : parseMonth(req.query.month);
  if (req.query.month !== undefined && !monthStart) {
    return sendError(res, 400, 'Parâmetro "month" inválido (ex: 2026-06)');
  }

  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.color, c.closing_day, c.due_day, c.limit_amount,
              c.payment_account_id, c.archived, c.is_default,
              a.name AS payment_account_name,
              COALESCE((
                SELECT SUM(CASE WHEN t.type = 'despesa' THEN t.amount ELSE -t.amount END)
                  FROM transactions t
                 WHERE t.card_id = c.id AND t.user_id = c.user_id
              ), 0) AS outstanding,
              COALESCE((
                SELECT SUM(t.amount) FROM transactions t
                 WHERE t.card_id = c.id AND t.user_id = c.user_id AND t.type = 'despesa'
                   AND ($2::date IS NULL OR (t.date >= $2::date AND t.date < $2::date + INTERVAL '1 month'))
              ), 0) AS bill_total,
              (SELECT COUNT(*)::int FROM transactions t WHERE t.card_id = c.id) AS transaction_count
         FROM cards c
         LEFT JOIN accounts a ON a.id = c.payment_account_id
        WHERE c.user_id = $1
        ORDER BY c.archived, c.name`,
      [req.userId, monthStart],
    );

    res.json(
      result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        closingDay: row.closing_day,
        dueDay: row.due_day,
        limitAmount: row.limit_amount === null ? null : parseFloat(row.limit_amount),
        paymentAccountId: row.payment_account_id,
        paymentAccountName: row.payment_account_name,
        archived: row.archived,
        isDefault: row.is_default,
        outstanding: parseFloat(row.outstanding),
        billTotal: parseFloat(row.bill_total),
        transactionCount: row.transaction_count,
      })),
    );
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao buscar cartões");
  }
};

function parseBody(body: Record<string, unknown> | undefined) {
  const name = cleanText(body?.name, 50);
  if (!name) return { error: "Informe o nome do cartão" };

  const limitRaw = body?.limit_amount;
  const limit =
    limitRaw === undefined || limitRaw === null || limitRaw === "" ? null : toCents(limitRaw);
  if (limitRaw !== undefined && limitRaw !== null && limitRaw !== "" && limit === null) {
    return { error: "Limite inválido" };
  }

  return {
    data: {
      name,
      color: isValidHexColor(body?.color) ? body.color : "#7C3AED",
      closingDay: parseDay(body?.closing_day),
      dueDay: parseDay(body?.due_day),
      limit,
      paymentAccountId: body?.payment_account_id ? Number(body.payment_account_id) : null,
      isDefault: body?.is_default === true,
    },
  };
}

async function validatePaymentAccount(accountId: number | null, userId: number | undefined) {
  if (accountId === null) return true;
  const result = await pool.query("SELECT id FROM accounts WHERE id = $1 AND user_id = $2", [
    accountId,
    userId,
  ]);
  return result.rows.length > 0;
}

export const createCard = async (req: AuthRequest, res: Response) => {
  const parsed = parseBody(req.body);
  if ("error" in parsed) return sendError(res, 400, parsed.error);
  const { name, color, closingDay, dueDay, limit, paymentAccountId, isDefault } = parsed.data;

  try {
    if (!(await validatePaymentAccount(paymentAccountId, req.userId))) {
      return sendError(res, 404, "Conta de pagamento não encontrada");
    }
    const existing = await pool.query(
      "SELECT id FROM cards WHERE user_id = $1 AND LOWER(name) = LOWER($2)",
      [req.userId, name],
    );
    if (existing.rows.length > 0) return sendError(res, 409, "Já existe um cartão com esse nome");

    const id = await withTransaction(async (client) => {
      if (isDefault) {
        await client.query("UPDATE cards SET is_default = false WHERE user_id = $1", [req.userId]);
      }
      const result = await client.query(
        `INSERT INTO cards (user_id, name, color, closing_day, due_day, limit_amount,
                            payment_account_id, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          req.userId,
          name,
          color,
          closingDay,
          dueDay,
          limit === null ? null : centsToDecimal(limit),
          paymentAccountId,
          isDefault,
        ],
      );
      return result.rows[0].id;
    });
    res.status(201).json({ id });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao criar cartão");
  }
};

export const updateCard = async (req: AuthRequest, res: Response) => {
  const parsed = parseBody(req.body);
  if ("error" in parsed) return sendError(res, 400, parsed.error);
  const { name, color, closingDay, dueDay, limit, paymentAccountId, isDefault } = parsed.data;
  const archived = req.body?.archived === true;

  try {
    if (!(await validatePaymentAccount(paymentAccountId, req.userId))) {
      return sendError(res, 404, "Conta de pagamento não encontrada");
    }
    const duplicate = await pool.query(
      "SELECT id FROM cards WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND id <> $3",
      [req.userId, name, req.params.id],
    );
    if (duplicate.rows.length > 0) return sendError(res, 409, "Já existe um cartão com esse nome");

    const updated = await withTransaction(async (client) => {
      const wantsDefault = isDefault && !archived;
      if (wantsDefault) {
        await client.query("UPDATE cards SET is_default = false WHERE user_id = $1", [req.userId]);
      }
      const result = await client.query(
        `UPDATE cards SET name = $1, color = $2, closing_day = $3, due_day = $4,
                limit_amount = $5, payment_account_id = $6, archived = $7, is_default = $8
          WHERE id = $9 AND user_id = $10 RETURNING id`,
        [
          name,
          color,
          closingDay,
          dueDay,
          limit === null ? null : centsToDecimal(limit),
          paymentAccountId,
          archived,
          wantsDefault,
          req.params.id,
          req.userId,
        ],
      );
      return result.rows[0]?.id;
    });
    if (!updated) return sendError(res, 404, "Cartão não encontrado");
    res.json({ id: updated });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao atualizar cartão");
  }
};

export const deleteCard = async (req: AuthRequest, res: Response) => {
  try {
    const owned = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM transactions t WHERE t.card_id = c.id) AS used
         FROM cards c WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, req.userId],
    );
    const row = owned.rows[0];
    if (!row) return sendError(res, 404, "Cartão não encontrado");
    if (row.used > 0) {
      return sendError(
        res,
        409,
        `Este cartão tem ${row.used} lançamentos. Arquive o cartão em vez de excluir.`,
      );
    }

    await pool.query("DELETE FROM cards WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.userId,
    ]);
    res.status(204).send();
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao excluir cartão");
  }
};

export async function cardBelongsToUser(id: number, userId: number | undefined) {
  const result = await pool.query("SELECT id FROM cards WHERE id = $1 AND user_id = $2", [
    id,
    userId,
  ]);
  return result.rows.length > 0;
}
