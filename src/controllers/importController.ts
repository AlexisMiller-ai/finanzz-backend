import { Response } from "express";
import { pool, withTransaction } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import {
  PAYMENT_METHODS,
  PaymentMethod,
  TRANSACTION_TYPES,
  TransactionType,
  centsToDecimal,
  cleanText,
  isOneOf,
  parseDate,
  sendError,
  toCents,
} from "../utils/validation";

const MAX_ROWS = 500;
/** A data que o banco registra costuma cair alguns dias depois da compra. */
const MATCH_WINDOW_DAYS = 3;
/** Diferença tolerada quando o valor lançado na mão não bate com o do banco. */
const AMOUNT_TOLERANCE = 0.15;
const AMOUNT_TOLERANCE_MAX_CENTS = 3000;
const DESCRIPTION_MAX = 240;

interface ParsedRow {
  index: number;
  accountId: number | null;
  cardId: number | null;
  cents: number;
  type: TransactionType;
  categoryId: number | null;
  description: string | null;
  date: string;
  purchaseDate: string;
  paymentMethod: PaymentMethod;
  externalId: string | null;
}

interface MatchInfo {
  id: number;
  date: string;
  description: string | null;
  amount: number;
  /** "exact": mesmo valor. "amount-differs": valor lançado diferente do banco. */
  kind: "exact" | "amount-differs";
}

type RowStatus =
  | { index: number; status: "ok" }
  | { index: number; status: "match"; match: MatchInfo }
  | { index: number; status: "duplicate"; duplicateOf?: number; message: string }
  | { index: number; status: "error"; message: string };

function daysBetween(a: string, b: string) {
  const diff = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  return Math.abs(diff) / 86_400_000;
}

/** Chave usada quando a origem não traz identificador próprio. */
function fallbackKey(row: { date: string; cents: number; type: string; description: string | null }) {
  const description = (row.description ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return `${row.date}|${row.cents}|${row.type}|${description}`;
}

/**
 * Importa lançamentos em lote (extrato bancário ou fatura de cartão).
 * Com `dry_run: true` só analisa e devolve o que seria importado.
 */
export const importTransactions = async (req: AuthRequest, res: Response) => {
  const input = req.body?.transactions;
  const dryRun = req.body?.dry_run === true;

  if (!Array.isArray(input) || input.length === 0) {
    return sendError(res, 400, "Envie ao menos um lançamento para importar");
  }
  if (input.length > MAX_ROWS) {
    return sendError(res, 400, `Importe no máximo ${MAX_ROWS} lançamentos por vez`);
  }

  try {
    const categoriesResult = await pool.query(
      "SELECT id, type FROM categories WHERE user_id = $1",
      [req.userId],
    );
    const categoryTypes = new Map<number, string>(
      categoriesResult.rows.map((c) => [c.id, c.type]),
    );

    const accountsResult = await pool.query("SELECT id FROM accounts WHERE user_id = $1", [req.userId]);
    const accountIds = new Set<number>(accountsResult.rows.map((a) => a.id));
    const cardsResult = await pool.query("SELECT id FROM cards WHERE user_id = $1", [req.userId]);
    const cardIds = new Set<number>(cardsResult.rows.map((c) => c.id));

    const parsed: ParsedRow[] = [];
    const results: RowStatus[] = [];

    input.forEach((raw: Record<string, unknown>, index: number) => {
      const cents = toCents(raw?.amount);
      const date = parseDate(raw?.date);

      if (cents === null) {
        results.push({ index, status: "error", message: "Valor inválido" });
        return;
      }
      if (!date) {
        results.push({ index, status: "error", message: "Data inválida" });
        return;
      }
      if (!isOneOf(TRANSACTION_TYPES, raw?.type)) {
        results.push({ index, status: "error", message: "Tipo inválido" });
        return;
      }

      const type = raw.type;
      let paymentMethod: PaymentMethod = isOneOf(PAYMENT_METHODS, raw?.payment_method)
        ? raw.payment_method
        : "dinheiro";
      if (type === "receita" && paymentMethod === "credito") paymentMethod = "dinheiro";

      let categoryId: number | null = null;
      if (raw?.category_id !== null && raw?.category_id !== undefined && raw?.category_id !== "") {
        categoryId = Number(raw.category_id);
        const categoryType = categoryTypes.get(categoryId);
        if (!categoryType) {
          results.push({ index, status: "error", message: "Categoria não encontrada" });
          return;
        }
        if (categoryType !== type) {
          results.push({ index, status: "error", message: "Categoria de outro tipo" });
          return;
        }
      }

      parsed.push({
        index,
        accountId: accountIds.has(Number(raw?.account_id)) ? Number(raw.account_id) : null,
        cardId: cardIds.has(Number(raw?.card_id)) ? Number(raw.card_id) : null,
        cents,
        type,
        categoryId,
        description: cleanText(raw?.description, DESCRIPTION_MAX),
        date,
        purchaseDate:
          paymentMethod === "credito" ? (parseDate(raw?.purchase_date) ?? date) : date,
        paymentMethod,
        externalId: cleanText(raw?.external_id, 80),
      });
    });

    if (parsed.length === 0) {
      return res.json({ imported: 0, duplicates: 0, errors: results.length, results });
    }

    // Busca o que já existe no período do arquivo para comparar.
    const dates = parsed.map((row) => row.date).sort();
    const existing = await pool.query(
      `SELECT id, date, purchase_date, amount, type, description, external_id
         FROM transactions
        WHERE user_id = $1
          AND date >= ($2::date - INTERVAL '${MATCH_WINDOW_DAYS + 1} days')
          AND date <= ($3::date + INTERVAL '${MATCH_WINDOW_DAYS + 1} days')`,
      [req.userId, dates[0], dates[dates.length - 1]],
    );

    const byExternalId = new Map<string, number>();
    // Conta quantas vezes cada lançamento equivalente já existe: se o extrato
    // tem dois cafés iguais no mesmo dia e só um foi importado antes, o outro entra.
    const remaining = new Map<string, number>();

    // Lançamentos feitos na mão (sem identificador de origem) podem ser o mesmo
    // gasto que aparece no arquivo, só que com outra descrição e outra data.
    const candidates = existing.rows
      .filter((row) => !row.external_id)
      .map((row) => ({
        id: row.id as number,
        effectiveDate: (row.purchase_date ?? row.date) as string,
        date: row.date as string,
        cents: Math.round(parseFloat(row.amount) * 100),
        type: row.type as string,
        description: row.description as string | null,
        taken: false,
      }));

    for (const row of existing.rows) {
      if (row.external_id) byExternalId.set(row.external_id, row.id);
      const key = fallbackKey({
        date: row.date,
        cents: Math.round(parseFloat(row.amount) * 100),
        type: row.type,
        description: row.description,
      });
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }

    const toInsert: ParsedRow[] = [];
    for (const row of parsed) {
      const existingId = row.externalId ? byExternalId.get(row.externalId) : undefined;
      if (existingId) {
        results.push({
          index: row.index,
          status: "duplicate",
          duplicateOf: existingId,
          message: "Já importado antes",
        });
        continue;
      }

      const key = fallbackKey(row);
      const available = remaining.get(key) ?? 0;
      if (available > 0) {
        remaining.set(key, available - 1);
        results.push({
          index: row.index,
          status: "duplicate",
          message: "Já existe um lançamento igual nesta data",
        });
        continue;
      }

      // Na pré-visualização, procura um lançamento manual equivalente para conciliar.
      // Na importação confirmada isso não se aplica: o que o usuário escolheu entra.
      const effectiveDate = row.purchaseDate || row.date;
      const near = !dryRun ? [] : candidates.filter(
        (candidate) =>
          !candidate.taken &&
          candidate.type === row.type &&
          daysBetween(candidate.effectiveDate, effectiveDate) <= MATCH_WINDOW_DAYS,
      );
      const sameAmount = near.find((candidate) => candidate.cents === row.cents);
      const closeAmount =
        sameAmount ??
        near.find((candidate) => {
          const diff = Math.abs(candidate.cents - row.cents);
          return diff <= Math.min(row.cents * AMOUNT_TOLERANCE, AMOUNT_TOLERANCE_MAX_CENTS);
        });

      if (closeAmount) {
        closeAmount.taken = true;
        results.push({
          index: row.index,
          status: "match",
          match: {
            id: closeAmount.id,
            date: closeAmount.effectiveDate,
            description: closeAmount.description,
            amount: closeAmount.cents / 100,
            kind: sameAmount ? "exact" : "amount-differs",
          },
        });
        continue;
      }

      results.push({ index: row.index, status: "ok" });
      toInsert.push(row);
    }

    const summary = {
      imported: 0,
      matches: results.filter((r) => r.status === "match").length,
      duplicates: results.filter((r) => r.status === "duplicate").length,
      errors: results.filter((r) => r.status === "error").length,
      results: results.sort((a, b) => a.index - b.index),
    };

    if (dryRun) {
      return res.json({ ...summary, dryRun: true, toImport: toInsert.length });
    }

    const inserted = await withTransaction(async (client) => {
      let count = 0;
      for (const row of toInsert) {
        const result = await client.query(
          `INSERT INTO transactions
             (amount, type, category_id, description, date, purchase_date, payment_method, user_id,
              external_id, account_id, card_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (user_id, external_id) DO NOTHING`,
          [
            centsToDecimal(row.cents),
            row.type,
            row.categoryId,
            row.description,
            row.date,
            row.purchaseDate,
            row.paymentMethod,
            req.userId,
            row.externalId,
            row.accountId,
            row.cardId,
          ],
        );
        count += result.rowCount ?? 0;
      }
      return count;
    });

    res.status(201).json({ ...summary, imported: inserted });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao importar lançamentos");
  }
};
