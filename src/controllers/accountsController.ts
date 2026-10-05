import { Response } from "express";
import { pool, withTransaction } from "../config/db";
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
       AND t.settled
  ), 0)`;

export const getAccounts = async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.name, a.kind, a.color, a.initial_balance, a.archived, a.is_default,
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
        isDefault: row.is_default,
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
  return { data: { name, kind, color, initial, isDefault: body?.is_default === true } };
}

export const createAccount = async (req: AuthRequest, res: Response) => {
  const parsed = parseBody(req.body);
  if ("error" in parsed) return sendError(res, 400, parsed.error);
  const { name, kind, color, initial, isDefault } = parsed.data;

  try {
    const existing = await pool.query(
      "SELECT id FROM accounts WHERE user_id = $1 AND LOWER(name) = LOWER($2)",
      [req.userId, name],
    );
    if (existing.rows.length > 0) return sendError(res, 409, "Já existe uma conta com esse nome");

    const id = await withTransaction(async (client) => {
      // Só pode haver um favorito por usuário.
      if (isDefault) {
        await client.query("UPDATE accounts SET is_default = false WHERE user_id = $1", [req.userId]);
      }
      const result = await client.query(
        `INSERT INTO accounts (user_id, name, kind, color, initial_balance, is_default)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.userId, name, kind, color, initial.toFixed(2), isDefault],
      );
      return result.rows[0].id;
    });
    res.status(201).json({ id });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao criar conta");
  }
};

export const updateAccount = async (req: AuthRequest, res: Response) => {
  const parsed = parseBody(req.body);
  if ("error" in parsed) return sendError(res, 400, parsed.error);
  const { name, kind, color, initial, isDefault } = parsed.data;
  const archived = req.body?.archived === true;

  try {
    const duplicate = await pool.query(
      "SELECT id FROM accounts WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND id <> $3",
      [req.userId, name, req.params.id],
    );
    if (duplicate.rows.length > 0) return sendError(res, 409, "Já existe uma conta com esse nome");

    const updated = await withTransaction(async (client) => {
      // Conta arquivada não continua sendo a favorita.
      const wantsDefault = isDefault && !archived;
      if (wantsDefault) {
        await client.query("UPDATE accounts SET is_default = false WHERE user_id = $1", [req.userId]);
      }
      const result = await client.query(
        `UPDATE accounts SET name = $1, kind = $2, color = $3, initial_balance = $4,
                archived = $5, is_default = $6
          WHERE id = $7 AND user_id = $8 RETURNING id`,
        [name, kind, color, initial.toFixed(2), archived, wantsDefault, req.params.id, req.userId],
      );
      return result.rows[0]?.id;
    });
    if (!updated) return sendError(res, 404, "Conta não encontrada");
    res.json({ id: updated });
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
/**
 * Ajusta o saldo inicial para que o saldo exibido fique igual ao informado.
 * Mesma ideia do ajuste do total guardado: o usuário diz quanto tem hoje na
 * conta e o sistema descobre de onde a conta partiu.
 */
export const adjustBalance = async (req: AuthRequest, res: Response) => {
  const target = Number(req.body?.current_balance);
  if (req.body?.current_balance === undefined || !Number.isFinite(target) || Math.abs(target) >= 1e8) {
    return sendError(res, 400, "Informe o saldo atual da conta");
  }

  try {
    const movement = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN t.type = 'receita' THEN t.amount ELSE -t.amount END), 0) AS net
         FROM transactions t
        WHERE t.account_id = $1 AND t.user_id = $2 AND t.date <= CURRENT_DATE AND t.settled`,
      [req.params.id, req.userId],
    );
    const net = parseFloat(movement.rows[0].net);
    const initial = Math.round((target - net) * 100) / 100;

    const result = await pool.query(
      "UPDATE accounts SET initial_balance = $1 WHERE id = $2 AND user_id = $3 RETURNING id",
      [initial.toFixed(2), req.params.id, req.userId],
    );
    if (result.rows.length === 0) return sendError(res, 404, "Conta não encontrada");

    res.json({ initialBalance: initial, balance: target, movement: net });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao ajustar saldo");
  }
};

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

