import { Response } from "express";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { cleanText, isOneOf, isValidHexColor, sendError } from "../utils/validation";

export const ACCOUNT_KINDS = ["corrente", "poupanca", "dinheiro", "investimento"] as const;

/**
 * Saldo = saldo inicial + entradas - saídas da conta.
 * Transferências entram no saldo (o dinheiro realmente muda de lugar), mesmo
 * ficando de fora dos totais de receita e despesa do mês.
 */
const BALANCE_EXPR = `
  a.initial_balance + COALESCE((
    SELECT SUM(CASE WHEN t.type = 'receita' THEN t.amount ELSE -t.amount END)
      FROM transactions t
     WHERE t.account_id = a.id AND t.user_id = a.user_id AND t.date <= CURRENT_DATE
  ), 0)`;

export const getAccounts = async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.name, a.kind, a.color, a.initial_balance, a.archived,
              ${BALANCE_EXPR} AS balance,
              (SELECT COUNT(*)::int FROM transactions t WHERE t.account_id = a.id) AS transaction_count
         FROM accounts a
        WHERE a.user_id = $1
        ORDER BY a.archived, a.name`,
      [req.userId],
    );

    res.json(
      result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        color: row.color,
        initialBalance: parseFloat(row.initial_balance),
        balance: parseFloat(row.balance),
        archived: row.archived,
        transactionCount: row.transaction_count,
      })),
    );
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao buscar contas");
  }
};

function parseBody(body: Record<string, unknown> | undefined) {
  const name = cleanText(body?.name, 50);
  const kind = isOneOf(ACCOUNT_KINDS, body?.kind) ? body.kind : "corrente";
  const color = isValidHexColor(body?.color) ? body.color : "#7C3AED";
  // O saldo inicial pode ser negativo (conta no vermelho) ou zero.
  const raw = body?.initial_balance;
  const initial = raw === undefined || raw === null || raw === "" ? 0 : Number(raw);
  if (!name) return { error: "Informe o nome da conta" };
  if (!Number.isFinite(initial) || Math.abs(initial) >= 1e8) {
    return { error: "Saldo inicial inválido" };
  }
  return { data: { name, kind, color, initial } };
}

export const createAccount = async (req: AuthRequest, res: Response) => {
  const parsed = parseBody(req.body);
  if ("error" in parsed) return sendError(res, 400, parsed.error);
  const { name, kind, color, initial } = parsed.data;

  try {
    const existing = await pool.query(
      "SELECT id FROM accounts WHERE user_id = $1 AND LOWER(name) = LOWER($2)",
      [req.userId, name],
    );
    if (existing.rows.length > 0) return sendError(res, 409, "Já existe uma conta com esse nome");

    const result = await pool.query(
      `INSERT INTO accounts (user_id, name, kind, color, initial_balance)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.userId, name, kind, color, initial.toFixed(2)],
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao criar conta");
  }
};

export const updateAccount = async (req: AuthRequest, res: Response) => {
  const parsed = parseBody(req.body);
  if ("error" in parsed) return sendError(res, 400, parsed.error);
  const { name, kind, color, initial } = parsed.data;
  const archived = req.body?.archived === true;

  try {
    const duplicate = await pool.query(
      "SELECT id FROM accounts WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND id <> $3",
      [req.userId, name, req.params.id],
    );
    if (duplicate.rows.length > 0) return sendError(res, 409, "Já existe uma conta com esse nome");

    const result = await pool.query(
      `UPDATE accounts SET name = $1, kind = $2, color = $3, initial_balance = $4, archived = $5
        WHERE id = $6 AND user_id = $7 RETURNING id`,
      [name, kind, color, initial.toFixed(2), archived, req.params.id, req.userId],
    );
    if (result.rows.length === 0) return sendError(res, 404, "Conta não encontrada");
    res.json({ id: result.rows[0].id });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao atualizar conta");
  }
};

export const deleteAccount = async (req: AuthRequest, res: Response) => {
  try {
    const owned = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM transactions t WHERE t.account_id = a.id) AS used,
              (SELECT COUNT(*)::int FROM cards c WHERE c.payment_account_id = a.id) AS cards
         FROM accounts a WHERE a.id = $1 AND a.user_id = $2`,
      [req.params.id, req.userId],
    );
    const row = owned.rows[0];
    if (!row) return sendError(res, 404, "Conta não encontrada");
    if (row.used > 0) {
      return sendError(
        res,
        409,
        `Esta conta tem ${row.used} lançamentos. Arquive a conta em vez de excluir.`,
      );
    }

    if (row.cards > 0) {
      await pool.query(
        "UPDATE cards SET payment_account_id = NULL WHERE payment_account_id = $1 AND user_id = $2",
        [req.params.id, req.userId],
      );
    }
    await pool.query("DELETE FROM accounts WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.userId,
    ]);
    res.status(204).send();
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao excluir conta");
  }
};

/** Soma dos saldos das contas ativas — quanto o usuário tem hoje. */
export async function getTotalBalance(userId: number | undefined) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(${BALANCE_EXPR}), 0) AS total
       FROM accounts a WHERE a.user_id = $1 AND a.archived = false`,
    [userId],
  );
  return parseFloat(result.rows[0].total);
}

/** Usado na validação de lançamentos: a conta existe e é do usuário? */
export async function accountBelongsToUser(id: number, userId: number | undefined) {
  const result = await pool.query("SELECT id FROM accounts WHERE id = $1 AND user_id = $2", [
    id,
    userId,
  ]);
  return result.rows.length > 0;
}

