import { Response } from "express";
import crypto from "crypto";
import { pool, withTransaction } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { billClosingDate, billDueDate, openBillMonth } from "../utils/bills";
import {
  addMonths,
  centsToDecimal,
  cleanText,
  isOneOf,
  parseDate,
  parseMonth,
  sendError,
  todayInBrazil,
} from "../utils/validation";

const SETTLEMENT_KINDS = ["transferencia", "externo", "lancado"] as const;
type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

type CardRow = {
  id: number;
  name: string;
  closing_day: number | null;
  due_day: number | null;
  payment_account_id: number | null;
};

type BillStatus = "paga" | "fechada" | "aberta" | "futura";

type Bill = {
  month: string;
  total: number;
  credits: number;
  remaining: number;
  status: BillStatus;
  closingDate: string | null;
  dueDate: string | null;
  items: number;
  payment: { kind: SettlementKind; amount: number; date: string } | null;
};

async function loadCard(id: unknown, userId: number | undefined): Promise<CardRow | null> {
  const result = await pool.query(
    `SELECT id, name, closing_day, due_day, payment_account_id
       FROM cards WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return result.rows[0] ?? null;
}

/**
 * Mês em que o pagamento de uma fatura entra no extrato. Normalmente é o mês
 * da própria fatura (fecha dia 3, vence dia 10); quando o vencimento cai antes
 * do fechamento, o pagamento acontece no mês seguinte.
 */
function creditMonthOf(billMonth: string, card: CardRow): string {
  const closing = card.closing_day;
  const due = card.due_day;
  const month = closing && due && due < closing ? addMonths(billMonth, 1) : billMonth;
  return month.slice(0, 7);
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Faturas do cartão: uma linha por mês de referência, da mais nova à mais antiga. */
async function listBills(card: CardRow, userId: number | undefined): Promise<Bill[]> {
  const [movement, paid] = await Promise.all([
    pool.query(
      `SELECT to_char(t.date, 'YYYY-MM') AS month,
              COALESCE(SUM(CASE WHEN t.type = 'despesa' THEN t.amount ELSE 0 END), 0) AS expenses,
              COALESCE(SUM(CASE WHEN t.type = 'receita' THEN t.amount ELSE 0 END), 0) AS credits,
              COUNT(*) FILTER (WHERE t.type = 'despesa')::int AS items
         FROM transactions t
        WHERE t.card_id = $1 AND t.user_id = $2
        GROUP BY 1`,
      [card.id, userId],
    ),
    pool.query(
      `SELECT to_char(bill_month, 'YYYY-MM') AS month, amount, kind, paid_date
         FROM card_bills WHERE card_id = $1 AND user_id = $2`,
      [card.id, userId],
    ),
  ]);

  const expenses = new Map<string, { total: number; items: number }>();
  const credits = new Map<string, number>();
  for (const row of movement.rows) {
    const total = parseFloat(row.expenses);
    if (total !== 0 || row.items > 0) expenses.set(row.month, { total, items: row.items });
    const credit = parseFloat(row.credits);
    if (credit !== 0) credits.set(row.month, credit);
  }

  const payments = new Map<string, Bill["payment"]>();
  for (const row of paid.rows) {
    payments.set(row.month, {
      kind: row.kind,
      amount: parseFloat(row.amount),
      date: row.paid_date,
    });
  }

  const open = openBillMonth(card.closing_day, todayInBrazil()).slice(0, 7);
  const months = new Set<string>([...expenses.keys(), ...payments.keys(), open]);

  return [...months]
    .sort((a, b) => b.localeCompare(a))
    .map((month) => {
      const expense = expenses.get(month) ?? { total: 0, items: 0 };
      const credit = credits.get(creditMonthOf(`${month}-01`, card)) ?? 0;
      const payment = payments.get(month) ?? null;
      const status: BillStatus = payment
        ? "paga"
        : month < open
          ? "fechada"
          : month === open
            ? "aberta"
            : "futura";
      return {
        month,
        total: round(expense.total),
        credits: round(credit),
        // Fatura paga fora do app abate pelo valor pago; o que entrou depois
        // do pagamento volta a aparecer como dívida daquela fatura.
        remaining: Math.max(
          round(expense.total - credit - (payment?.kind === "externo" ? payment.amount : 0)),
          0,
        ),
        status,
        closingDate: billClosingDate(`${month}-01`, card.closing_day),
        dueDate: billDueDate(`${month}-01`, card.closing_day, card.due_day),
        items: expense.items,
        payment,
      };
    });
}

export const getBills = async (req: AuthRequest, res: Response) => {
  try {
    const card = await loadCard(req.params.id, req.userId);
    if (!card) return sendError(res, 404, "Cartão não encontrado");
    const bills = await listBills(card, req.userId);
    res.json({
      cardId: card.id,
      cardName: card.name,
      openBillMonth: openBillMonth(card.closing_day, todayInBrazil()).slice(0, 7),
      bills,
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao buscar as faturas");
  }
};

/** Como toCents, mas aceita zero (dar baixa sem valor é permitido). */
function parseAmount(value: unknown): number | null {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  const cents = Math.round(num * 100);
  return cents >= 0 && cents < 1e10 ? cents : null;
}

/**
 * Dá baixa numa fatura: ela deixa de contar como dívida e passa a aparecer
 * como paga. Três formas, conforme o dinheiro já estar registrado ou não:
 *   transferencia -> cria a saída da conta escolhida (o jeito completo)
 *   externo       -> pago fora do app, sem mexer no saldo de nenhuma conta
 *   lancado       -> o pagamento já estava lançado à mão no app
 */
export const payBill = async (req: AuthRequest, res: Response) => {
  const month = parseMonth(req.params.month);
  if (!month) return sendError(res, 400, "Mês da fatura inválido (ex: 2026-09)");

  const body = req.body ?? {};
  const kind: SettlementKind = isOneOf(SETTLEMENT_KINDS, body.kind)
    ? body.kind
    : body.from_account_id
      ? "transferencia"
      : "externo";
  const date = body.date === undefined ? todayInBrazil() : parseDate(body.date);
  if (!date) return sendError(res, 400, "Data do pagamento inválida");
  const description = cleanText(body.description, 200);

  try {
    const card = await loadCard(req.params.id, req.userId);
    if (!card) return sendError(res, 404, "Cartão não encontrado");

    const open = openBillMonth(card.closing_day, todayInBrazil()).slice(0, 7);
    if (month.slice(0, 7) > open) {
      return sendError(res, 400, "Essa fatura ainda não abriu — a baixa vale da fatura atual para trás");
    }

    const bills = await listBills(card, req.userId);
    const bill = bills.find((item) => item.month === month.slice(0, 7));
    if (bill?.payment) return sendError(res, 409, "Essa fatura já está marcada como paga");

    const cents =
      body.amount === undefined
        ? Math.round((bill?.remaining ?? 0) * 100)
        : parseAmount(body.amount);
    if (cents === null) return sendError(res, 400, "Valor do pagamento inválido");

    const accountId =
      kind !== "transferencia"
        ? null
        : body.from_account_id
          ? Number(body.from_account_id)
          : card.payment_account_id;
    if (kind === "transferencia") {
      if (!Number.isInteger(accountId)) {
        return sendError(res, 400, "Informe a conta que vai pagar a fatura");
      }
      if (cents === 0) {
        return sendError(res, 400, "Para registrar o pagamento, informe um valor maior que zero");
      }
    }

    const result = await withTransaction(async (client) => {
      let transferId: string | null = null;
      if (kind === "transferencia") {
        const account = await client.query(
          "SELECT name FROM accounts WHERE id = $1 AND user_id = $2",
          [accountId, req.userId],
        );
        if (account.rows.length === 0) throw new Error("CONTA");

        transferId = crypto.randomUUID();
        const label = description ?? `Pagamento de fatura ${card.name}`;
        const value = centsToDecimal(cents);
        await client.query(
          `INSERT INTO transactions
             (amount, type, description, date, purchase_date, payment_method, user_id, account_id, transfer_id)
           VALUES ($1, 'despesa', $2, $3, $3, 'dinheiro', $4, $5, $6)`,
          [value, label, date, req.userId, accountId, transferId],
        );
        await client.query(
          `INSERT INTO transactions
             (amount, type, description, date, purchase_date, payment_method, user_id, card_id, transfer_id)
           VALUES ($1, 'receita', $2, $3, $3, 'dinheiro', $4, $5, $6)`,
          [value, label, date, req.userId, card.id, transferId],
        );
      }

      const inserted = await client.query(
        `INSERT INTO card_bills (user_id, card_id, bill_month, amount, paid_date, kind, transfer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.userId, card.id, month, centsToDecimal(cents), date, kind, transferId],
      );
      return { id: inserted.rows[0].id, transferId };
    });

    res.status(201).json({
      id: result.id,
      month: month.slice(0, 7),
      kind,
      amount: cents / 100,
      date,
      transferId: result.transferId,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "CONTA") {
      return sendError(res, 404, "Conta de pagamento não encontrada");
    }
    if (error instanceof Error && /card_bills_card_month_key/.test(error.message)) {
      return sendError(res, 409, "Essa fatura já está marcada como paga");
    }
    console.error(error);
    sendError(res, 500, "Erro ao dar baixa na fatura");
  }
};

/** Desfaz a baixa. Se o pagamento criou uma transferência, ela também sai. */
export const unpayBill = async (req: AuthRequest, res: Response) => {
  const month = parseMonth(req.params.month);
  if (!month) return sendError(res, 400, "Mês da fatura inválido (ex: 2026-09)");

  try {
    const card = await loadCard(req.params.id, req.userId);
    if (!card) return sendError(res, 404, "Cartão não encontrado");

    const removed = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, transfer_id FROM card_bills
          WHERE card_id = $1 AND user_id = $2 AND bill_month = $3`,
        [card.id, req.userId, month],
      );
      const row = existing.rows[0];
      if (!row) return null;

      let transferRemoved = 0;
      if (row.transfer_id) {
        const deleted = await client.query(
          "DELETE FROM transactions WHERE transfer_id = $1 AND user_id = $2",
          [row.transfer_id, req.userId],
        );
        transferRemoved = deleted.rowCount ?? 0;
      }
      await client.query("DELETE FROM card_bills WHERE id = $1", [row.id]);
      return { transferRemoved };
    });

    if (!removed) return sendError(res, 404, "Essa fatura não está marcada como paga");
    res.json({ month: month.slice(0, 7), ...removed });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao desfazer a baixa da fatura");
  }
};

/**
 * Dá baixa de uma vez em todas as faturas que já fecharam — o caso de quem
 * começou a usar o app no meio do caminho, ou acabou de mover compras entre
 * cartões, e já pagou tudo que era de antes. Zera também o ajuste manual:
 * depois disso a dívida do cartão é só a fatura aberta.
 */
export const settlePastBills = async (req: AuthRequest, res: Response) => {
  const date = req.body?.date === undefined ? todayInBrazil() : parseDate(req.body.date);
  if (!date) return sendError(res, 400, "Data do pagamento inválida");

  try {
    const card = await loadCard(req.params.id, req.userId);
    if (!card) return sendError(res, 404, "Cartão não encontrado");

    const open = openBillMonth(card.closing_day, todayInBrazil()).slice(0, 7);
    const bills = await listBills(card, req.userId);
    // Tudo que já fechou e ainda deve algo — inclusive fatura já marcada como
    // paga que recebeu lançamento depois (compra movida de outro cartão).
    const pending = bills.filter(
      (bill) => bill.month < open && (bill.status === "fechada" || bill.remaining > 0),
    );

    const previousAdjustment = await withTransaction(async (client) => {
      for (const bill of pending) {
        // Fatura cujo pagamento já está lançado não desconta a dívida de novo.
        const kind: SettlementKind = bill.remaining > 0 ? "externo" : "lancado";
        const amount = bill.remaining > 0 ? bill.remaining : bill.total;
        await client.query(
          `INSERT INTO card_bills (user_id, card_id, bill_month, amount, paid_date, kind)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (card_id, bill_month) DO UPDATE
              SET amount = CASE WHEN card_bills.kind = 'externo'
                                THEN card_bills.amount + EXCLUDED.amount
                                ELSE EXCLUDED.amount END,
                  kind = EXCLUDED.kind,
                  paid_date = EXCLUDED.paid_date`,
          [req.userId, card.id, `${bill.month}-01`, amount.toFixed(2), date, kind],
        );
      }
      const before = await client.query(
        "SELECT outstanding_adjustment FROM cards WHERE id = $1 AND user_id = $2",
        [card.id, req.userId],
      );
      await client.query(
        "UPDATE cards SET outstanding_adjustment = 0 WHERE id = $1 AND user_id = $2",
        [card.id, req.userId],
      );
      return parseFloat(before.rows[0]?.outstanding_adjustment ?? "0");
    });

    res.json({
      settled: pending.length,
      months: pending.map((bill) => bill.month),
      previousAdjustment,
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao dar baixa nas faturas anteriores");
  }
};
