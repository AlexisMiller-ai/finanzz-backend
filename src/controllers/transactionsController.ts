import { Response } from "express";
import crypto from "crypto";
import { PoolClient } from "pg";
import { pool, withTransaction } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import {
  PAYMENT_METHODS,
  PaymentMethod,
  TRANSACTION_TYPES,
  TransactionType,
  addMonths,
  centsToDecimal,
  cleanText,
  isOneOf,
  parseDate,
  parseMonth,
  sendError,
  toCents,
} from "../utils/validation";

const MAX_INSTALLMENTS = 72;
const MAX_REPEAT_MONTHS = 60;
const DESCRIPTION_MAX = 240; // coluna tem 255; sobra espaço para o sufixo " (12/12)"
const INSTALLMENT_SUFFIX = /\s*\(\d+\/\d+\)$/;

type Scope = "single" | "future" | "all";

const SELECT_WITH_CATEGORY = `
  SELECT t.*,
         c.name AS category_name, c.color AS category_color,
         a.name AS account_name, a.color AS account_color,
         cd.name AS card_name, cd.color AS card_color
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN cards cd ON cd.id = t.card_id`;

interface TransactionInput {
  cents: number;
  type: TransactionType;
  categoryId: number | null;
  description: string | null;
  date: string;
  purchaseDate: string;
  paymentMethod: PaymentMethod;
  accountId: number | null;
  cardId: number | null;
}

/** Valida o corpo da requisição. Devolve a mensagem de erro ou os dados limpos. */
async function parseInput(
  req: AuthRequest,
): Promise<{ error: string } | { data: TransactionInput }> {
  const body = req.body ?? {};
  const cents = toCents(body.amount);
  if (cents === null) return { error: "Informe um valor maior que zero" };

  if (!isOneOf(TRANSACTION_TYPES, body.type)) {
    return { error: "Tipo inválido (use despesa ou receita)" };
  }
  const type = body.type;

  const date = parseDate(body.date);
  if (!date) return { error: "Data inválida" };

  let paymentMethod: PaymentMethod = isOneOf(PAYMENT_METHODS, body.payment_method)
    ? body.payment_method
    : "dinheiro";
  // Receita no cartão de crédito não faz sentido e mudava a data para o dia 1º da fatura.
  if (type === "receita" && paymentMethod === "credito") paymentMethod = "dinheiro";

  const purchaseDate =
    paymentMethod === "credito" ? (parseDate(body.purchase_date) ?? date) : date;

  let categoryId: number | null = null;
  if (body.category_id !== null && body.category_id !== undefined && body.category_id !== "") {
    categoryId = Number(body.category_id);
    const category = await pool.query(
      "SELECT type FROM categories WHERE id = $1 AND user_id = $2",
      [categoryId, req.userId],
    );
    if (!category.rows[0]) return { error: "Categoria não encontrada" };
    if (category.rows[0].type !== type) {
      return { error: "A categoria escolhida não é do mesmo tipo do lançamento" };
    }
  }

  const description = cleanText(body.description, DESCRIPTION_MAX)?.replace(
    INSTALLMENT_SUFFIX,
    "",
  ) || null;

  // Despesa no crédito pertence a um cartão; todo o resto, a uma conta.
  const wantsCard = type === "despesa" && paymentMethod === "credito";
  let accountId: number | null = null;
  let cardId: number | null = null;

  if (wantsCard) {
    cardId = body.card_id ? Number(body.card_id) : await firstOf("cards", req.userId);
    if (cardId && !(await belongsToUser("cards", cardId, req.userId))) {
      return { error: "Cartão não encontrado" };
    }
  } else {
    accountId = body.account_id ? Number(body.account_id) : await firstOf("accounts", req.userId);
    if (accountId && !(await belongsToUser("accounts", accountId, req.userId))) {
      return { error: "Conta não encontrada" };
    }
  }

  return {
    data: {
      cents, type, categoryId, description, date, purchaseDate, paymentMethod, accountId, cardId,
    },
  };
}

/** A tabela só pode ser "accounts" ou "cards" (valor interno, nunca do usuário). */
async function belongsToUser(table: "accounts" | "cards", id: number, userId: number | undefined) {
  const result = await pool.query(
    `SELECT id FROM ${table} WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rows.length > 0;
}

/**
 * Conta/cartão padrão de quem não escolheu nada no formulário. Se ainda não
 * existe nenhum, cria — assim nenhum lançamento fica sem lugar, e o usuário
 * renomeia depois na tela de contas.
 */
async function firstOf(table: "accounts" | "cards", userId: number | undefined) {
  const result = await pool.query(
    `SELECT id FROM ${table} WHERE user_id = $1 AND archived = false ORDER BY id LIMIT 1`,
    [userId],
  );
  if (result.rows[0]) return result.rows[0].id as number;

  const created = await pool.query(
    table === "cards"
      ? "INSERT INTO cards (user_id, name) VALUES ($1, 'Cartão de crédito') RETURNING id"
      : "INSERT INTO accounts (user_id, name, kind) VALUES ($1, 'Conta principal', 'corrente') RETURNING id",
    [userId],
  );
  return created.rows[0].id as number;
}

function installmentDescription(base: string | null, n: number, total: number) {
  return base ? `${base} (${n}/${total})` : `(${n}/${total})`;
}

async function insertRow(
  client: PoolClient,
  userId: number | undefined,
  input: TransactionInput,
  extra: {
    installmentGroupId?: string;
    installmentNumber?: number;
    installmentTotal?: number;
    recurrenceId?: string;
  } = {},
) {
  const result = await client.query(
    `INSERT INTO transactions
      (amount, type, category_id, description, date, purchase_date, payment_method, user_id,
       installment_group_id, installment_number, installment_total, recurrence_id, account_id, card_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      centsToDecimal(input.cents),
      input.type,
      input.categoryId,
      input.description,
      input.date,
      input.purchaseDate,
      input.paymentMethod,
      userId,
      extra.installmentGroupId ?? null,
      extra.installmentNumber ?? null,
      extra.installmentTotal ?? null,
      extra.recurrenceId ?? null,
      input.accountId,
      input.cardId,
    ],
  );
  return result.rows[0];
}

export const getTransactions = async (req: AuthRequest, res: Response) => {
  const params: unknown[] = [req.userId];
  let where = "WHERE t.user_id = $1";

  if (req.query.month !== undefined) {
    const monthStart = parseMonth(req.query.month);
    if (!monthStart) {
      return sendError(res, 400, 'Parâmetro "month" inválido (ex: 2026-06)');
    }
    params.push(monthStart);
    where += " AND t.date >= $2::date AND t.date < ($2::date + INTERVAL '1 month')";
  }

  try {
    const result = await pool.query(
      `${SELECT_WITH_CATEGORY} ${where} ORDER BY t.date DESC, t.id DESC`,
      params,
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao buscar lançamentos");
  }
};

export const createTransaction = async (req: AuthRequest, res: Response) => {
  const parsed = await parseInput(req).catch((error) => {
    console.error(error);
    return { error: "Erro ao validar lançamento" };
  });
  if ("error" in parsed) return sendError(res, 400, parsed.error);
  const input = parsed.data;

  const installments = Number(req.body.installments ?? 0);
  const wantsInstallments = !!req.body.is_installment && installments > 1;
  const repeatMonths = Number(req.body.repeat_months ?? 0);
  const wantsRecurrence = repeatMonths > 1;

  if (wantsInstallments && wantsRecurrence) {
    return sendError(res, 400, "Escolha parcelamento ou repetição, não os dois");
  }
  if (wantsInstallments) {
    if (input.type !== "despesa") {
      return sendError(res, 400, "Somente despesas podem ser parceladas");
    }
    if (!Number.isInteger(installments) || installments > MAX_INSTALLMENTS) {
      return sendError(res, 400, `Parcelas devem ser entre 2 e ${MAX_INSTALLMENTS}`);
    }
    if (input.cents < installments) {
      return sendError(res, 400, "Valor muito baixo para esse número de parcelas");
    }
  }
  if (wantsRecurrence && (!Number.isInteger(repeatMonths) || repeatMonths > MAX_REPEAT_MONTHS)) {
    return sendError(res, 400, `Repetição deve ser entre 2 e ${MAX_REPEAT_MONTHS} meses`);
  }

  try {
    const rows = await withTransaction(async (client) => {
      if (wantsInstallments) {
        // Divide em centavos para a soma das parcelas bater exatamente com o total.
        const base = Math.floor(input.cents / installments);
        const remainder = input.cents - base * installments;
        const groupId = crypto.randomUUID();
        const created = [];
        for (let i = 1; i <= installments; i++) {
          created.push(
            await insertRow(
              client,
              req.userId,
              {
                ...input,
                cents: i === installments ? base + remainder : base,
                description: installmentDescription(input.description, i, installments),
                date: addMonths(input.date, i - 1),
              },
              {
                installmentGroupId: groupId,
                installmentNumber: i,
                installmentTotal: installments,
              },
            ),
          );
        }
        return created;
      }

      if (wantsRecurrence) {
        const recurrenceId = crypto.randomUUID();
        const created = [];
        for (let i = 0; i < repeatMonths; i++) {
          created.push(
            await insertRow(
              client,
              req.userId,
              {
                ...input,
                date: addMonths(input.date, i),
                purchaseDate: addMonths(input.purchaseDate, i),
              },
              { recurrenceId },
            ),
          );
        }
        return created;
      }

      return [await insertRow(client, req.userId, input)];
    });

    res.status(201).json({ transactions: rows });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao criar lançamento");
  }
};

async function isTransferRow(id: unknown, userId: number | undefined) {
  const result = await pool.query(
    "SELECT id FROM transactions WHERE id = $1 AND user_id = $2 AND transfer_id IS NOT NULL",
    [id, userId],
  );
  return result.rows.length > 0;
}

function parseScope(value: unknown): Scope {
  return value === "future" || value === "all" ? value : "single";
}

/** Busca o lançamento e monta o filtro SQL do escopo (só ele, ele e os próximos, ou a série toda). */
async function resolveScope(req: AuthRequest, scope: Scope) {
  const result = await pool.query(
    "SELECT * FROM transactions WHERE id = $1 AND user_id = $2",
    [req.params.id, req.userId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const groupColumn = row.installment_group_id
    ? "installment_group_id"
    : row.recurrence_id
      ? "recurrence_id"
      : null;

  if (scope === "single" || !groupColumn) {
    return { row, where: "id = $1 AND user_id = $2", params: [row.id, req.userId] };
  }

  const groupId = row[groupColumn];
  if (scope === "all") {
    return {
      row,
      where: `${groupColumn} = $1 AND user_id = $2`,
      params: [groupId, req.userId],
    };
  }
  return {
    row,
    where: `${groupColumn} = $1 AND user_id = $2 AND (date > $3 OR id = $4 OR (date = $3 AND id > $4))`,
    params: [groupId, req.userId, row.date, row.id],
  };
}

export const updateTransaction = async (req: AuthRequest, res: Response) => {
  const scope = parseScope(req.body?.scope);

  try {
    if (await isTransferRow(req.params.id, req.userId)) {
      return sendError(
        res,
        400,
        "Este lançamento faz parte de uma transferência. Exclua a transferência e crie de novo.",
      );
    }
    const parsed = await parseInput(req);
    if ("error" in parsed) return sendError(res, 400, parsed.error);
    const input = parsed.data;

    const target = await resolveScope(req, scope);
    if (!target) return sendError(res, 404, "Lançamento não encontrado");

    const values = [
      centsToDecimal(input.cents),
      input.type,
      input.categoryId,
      input.description,
      input.paymentMethod,
    ];
    // Parcelas guardam o sufixo "(n/total)" na descrição.
    const descriptionSql = `CASE WHEN installment_total IS NOT NULL
        THEN CASE WHEN $4::text IS NULL THEN '(' || installment_number || '/' || installment_total || ')'
                  ELSE $4::text || ' (' || installment_number || '/' || installment_total || ')' END
        ELSE $4::text END`;

    let sql: string;
    let params: unknown[];
    if (scope === "single" || target.where.startsWith("id =")) {
      sql = `UPDATE transactions
             SET amount = $1, type = $2, category_id = $3, description = ${descriptionSql},
                 payment_method = $5, date = $6, purchase_date = $7,
                 account_id = $8, card_id = $9
             WHERE id = $10 AND user_id = $11 RETURNING *`;
      params = [
        ...values,
        input.date,
        input.purchaseDate,
        input.accountId,
        input.cardId,
        target.row.id,
        req.userId,
      ];
    } else {
      // Em lote as datas de cada mês são preservadas.
      const shifted = target.where.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 7}`);
      sql = `UPDATE transactions
             SET amount = $1, type = $2, category_id = $3, description = ${descriptionSql},
                 payment_method = $5::varchar,
                 account_id = $6, card_id = $7,
                 purchase_date = CASE WHEN $5::varchar = 'credito' THEN COALESCE(purchase_date, date) ELSE date END
             WHERE ${shifted} RETURNING *`;
      params = [...values, input.accountId, input.cardId, ...target.params];
    }

    const result = await pool.query(sql, params);
    res.json({ transactions: result.rows });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao atualizar lançamento");
  }
};

export const deleteTransaction = async (req: AuthRequest, res: Response) => {
  const scope = parseScope(req.query.scope);

  try {
    // Excluir uma ponta da transferência deixaria a outra órfã: apaga as duas.
    const transfer = await pool.query(
      "SELECT transfer_id FROM transactions WHERE id = $1 AND user_id = $2 AND transfer_id IS NOT NULL",
      [req.params.id, req.userId],
    );
    if (transfer.rows[0]) {
      const result = await pool.query(
        "DELETE FROM transactions WHERE transfer_id = $1 AND user_id = $2",
        [transfer.rows[0].transfer_id, req.userId],
      );
      return res.json({ deleted: result.rowCount });
    }

    const target = await resolveScope(req, scope);
    if (!target) return sendError(res, 404, "Lançamento não encontrado");

    const result = await pool.query(
      `DELETE FROM transactions WHERE ${target.where}`,
      target.params,
    );
    res.json({ deleted: result.rowCount });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao excluir lançamento");
  }
};

/** Mantido por compatibilidade: exclui todas as parcelas de uma compra. */
export const deleteInstallmentGroup = async (req: AuthRequest, res: Response) => {
  const { groupId } = req.params;
  if (typeof groupId !== "string" || !/^[0-9a-f-]{36}$/i.test(groupId)) {
    return sendError(res, 400, "Identificador de parcelamento inválido");
  }

  try {
    const result = await pool.query(
      "DELETE FROM transactions WHERE installment_group_id = $1 AND user_id = $2",
      [groupId, req.userId],
    );
    res.json({ deleted: result.rowCount });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao excluir parcelamento");
  }
};
