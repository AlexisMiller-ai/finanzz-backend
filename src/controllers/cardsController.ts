import { Response } from "express";
import { pool, withTransaction } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { billClosingDate, billDueDate } from "../utils/bills";
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
 * Expressão SQL do mês da fatura aberta (a que ainda recebe compras).
 * A partir do dia de fechamento, as compras já entram na fatura seguinte.
 * Precisa de um alias "c" para a tabela cards.
 */
export const OPEN_BILL_SQL = `(CASE
        WHEN c.closing_day IS NOT NULL AND EXTRACT(DAY FROM CURRENT_DATE) >= c.closing_day
          THEN date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
        ELSE date_trunc('month', CURRENT_DATE)
      END)`;

/**
 * Crédito das faturas marcadas como pagas fora do app. Fica limitado ao que a
 * fatura realmente tem de dívida: se as compras daquele mês saírem do cartão
 * (mudança para outro cartão, exclusão), o crédito encolhe junto em vez de
 * virar saldo a favor.
 */
function settlementCredit(filter = ""): string {
  return `COALESCE((
                SELECT SUM(GREATEST(LEAST(b.amount, COALESCE((
                         SELECT SUM(CASE WHEN t.type = 'despesa' THEN t.amount ELSE -t.amount END)
                           FROM transactions t
                          WHERE t.card_id = c.id AND t.user_id = c.user_id
                            AND t.date >= b.bill_month
                            AND t.date < b.bill_month + INTERVAL '1 month'
                       ), 0)), 0))
                  FROM card_bills b
                 WHERE b.card_id = c.id AND b.kind = 'externo'${filter}
              ), 0)`;
}
/**
 * Cartões com o total da fatura do mês pedido, a fatura aberta e o que ainda
 * está devendo: faturas que já fecharam e não foram marcadas como pagas, mais
 * o que já entrou na fatura aberta.
 */
export const getCards = async (req: AuthRequest, res: Response) => {
  const monthStart = req.query.month === undefined ? null : parseMonth(req.query.month);
  if (req.query.month !== undefined && !monthStart) {
    return sendError(res, 400, 'Parâmetro "month" inválido (ex: 2026-06)');
  }

  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.color, c.closing_day, c.due_day, c.limit_amount,
              c.payment_account_id, c.archived, c.is_default, c.outstanding_adjustment,
              a.name AS payment_account_name,
              ${OPEN_BILL_SQL}::date AS open_bill_month,
              -- Dívida das faturas que já fecharam e seguem sem baixa.
              c.outstanding_adjustment + COALESCE((
                SELECT SUM(CASE WHEN t.type = 'despesa' THEN t.amount ELSE -t.amount END)
                  FROM transactions t
                 WHERE t.card_id = c.id AND t.user_id = c.user_id
                   AND t.date < ${OPEN_BILL_SQL}
              ), 0) - ${settlementCredit(" AND b.bill_month < " + OPEN_BILL_SQL)} AS closed_due,
              -- O que já caiu na fatura que está aberta.
              COALESCE((
                SELECT SUM(CASE WHEN t.type = 'despesa' THEN t.amount ELSE -t.amount END)
                  FROM transactions t
                 WHERE t.card_id = c.id AND t.user_id = c.user_id
                   AND t.date >= ${OPEN_BILL_SQL}
                   AND t.date < ${OPEN_BILL_SQL} + INTERVAL '1 month'
              ), 0) - ${settlementCredit(" AND b.bill_month = " + OPEN_BILL_SQL)} AS open_bill_due,
              COALESCE((
                SELECT SUM(t.amount) FROM transactions t
                 WHERE t.card_id = c.id AND t.user_id = c.user_id AND t.type = 'despesa'
                   AND t.date >= ${OPEN_BILL_SQL}
                   AND t.date < ${OPEN_BILL_SQL} + INTERVAL '1 month'
              ), 0) AS open_bill_total,
              EXISTS (
                SELECT 1 FROM card_bills b
                 WHERE b.card_id = c.id AND b.bill_month = ${OPEN_BILL_SQL}
              ) AS open_bill_paid,
              -- Faturas fechadas com gasto e sem baixa: o que falta acertar.
              (
                SELECT COUNT(*)::int FROM (
                  SELECT t.date FROM transactions t
                   WHERE t.card_id = c.id AND t.user_id = c.user_id AND t.type = 'despesa'
                     AND t.date < ${OPEN_BILL_SQL}
                   GROUP BY t.date
                  HAVING SUM(t.amount) <> 0
                ) meses
                WHERE NOT EXISTS (
                  SELECT 1 FROM card_bills b
                   WHERE b.card_id = c.id AND b.bill_month = meses.date
                )
              ) AS closed_unpaid_count,
              COALESCE((
                SELECT SUM(t.amount) FROM transactions t
                 WHERE t.card_id = c.id AND t.user_id = c.user_id AND t.type = 'despesa'
                   AND t.date >= ${OPEN_BILL_SQL} + INTERVAL '1 month'
              ), 0) AS future_installments,
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
      result.rows.map((row) => {
        const closedDue = parseFloat(row.closed_due);
        const openBillDue = parseFloat(row.open_bill_due);
        const openBillMonth = row.open_bill_month.slice(0, 7);
        return {
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
          // Dívida de hoje: faturas fechadas em aberto + o que já entrou na aberta.
          outstanding: Math.round((closedDue + openBillDue) * 100) / 100,
          closedDue,
          // Fatura que ainda está recebendo compras.
          openBillMonth,
          openBillTotal: parseFloat(row.open_bill_total),
          openBillClosingDate: billClosingDate(`${openBillMonth}-01`, row.closing_day),
          openBillDueDate: billDueDate(`${openBillMonth}-01`, row.closing_day, row.due_day),
          openBillPaid: row.open_bill_paid,
          closedUnpaidCount: row.closed_unpaid_count,
          futureInstallments: parseFloat(row.future_installments),
          outstandingAdjustment: parseFloat(row.outstanding_adjustment),
          billTotal: parseFloat(row.bill_total),
          transactionCount: row.transaction_count,
        };
      }),
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

    await withTransaction(async (client) => {
      await client.query("DELETE FROM card_bills WHERE card_id = $1 AND user_id = $2", [
        req.params.id,
        req.userId,
      ]);
      await client.query("DELETE FROM cards WHERE id = $1 AND user_id = $2", [
        req.params.id,
        req.userId,
      ]);
    });
    res.status(204).send();
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao excluir cartão");
  }
};

/**
 * Ajusta quanto o cartão deve hoje. Guarda a diferença entre o valor informado
 * e o calculado — útil para faturas antigas já pagas que nunca foram
 * registradas, ou depois de mover lançamentos entre cartões.
 */
export const adjustOutstanding = async (req: AuthRequest, res: Response) => {
  const target = Number(req.body?.current_outstanding);
  if (
    req.body?.current_outstanding === undefined ||
    !Number.isFinite(target) ||
    target < 0 ||
    target >= 1e8
  ) {
    return sendError(res, 400, "Informe quanto o cartão deve hoje");
  }

  try {
    const movement = await pool.query(
      `SELECT COALESCE((
                SELECT SUM(CASE WHEN t.type = 'despesa' THEN t.amount ELSE -t.amount END)
                  FROM transactions t
                 WHERE t.card_id = c.id AND t.user_id = c.user_id
                   AND t.date < ${OPEN_BILL_SQL} + INTERVAL '1 month'
              ), 0) - ${settlementCredit()} AS net
         FROM cards c WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, req.userId],
    );
    if (movement.rows.length === 0) return sendError(res, 404, "Cartão não encontrado");
    const net = parseFloat(movement.rows[0].net);
    const adjustment = Math.round((target - net) * 100) / 100;

    const result = await pool.query(
      "UPDATE cards SET outstanding_adjustment = $1 WHERE id = $2 AND user_id = $3 RETURNING id",
      [adjustment.toFixed(2), req.params.id, req.userId],
    );
    if (result.rows.length === 0) return sendError(res, 404, "Cartão não encontrado");

    res.json({ outstanding: target, outstandingAdjustment: adjustment, movement: net });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao ajustar a fatura em aberto");
  }
};

export async function cardBelongsToUser(id: number, userId: number | undefined) {
  const result = await pool.query("SELECT id FROM cards WHERE id = $1 AND user_id = $2", [
    id,
    userId,
  ]);
  return result.rows.length > 0;
}
