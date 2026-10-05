import { Response } from "express";
import crypto from "crypto";
import { withTransaction } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { centsToDecimal, cleanText, parseDate, sendError, toCents } from "../utils/validation";

/**
 * Transferência entre contas (ou pagamento de fatura: conta -> cartão).
 * Grava duas linhas com o mesmo transfer_id: saída na origem e entrada no
 * destino. As duas ficam fora dos totais de receita e despesa, porque o
 * dinheiro só mudou de lugar; os saldos das contas, esses sim, mudam.
 */
export const createTransfer = async (req: AuthRequest, res: Response) => {
  const body = req.body ?? {};
  const cents = toCents(body.amount);
  const date = parseDate(body.date);
  const fromAccountId = Number(body.from_account_id);
  const toAccountId = body.to_account_id ? Number(body.to_account_id) : null;
  const toCardId = body.to_card_id ? Number(body.to_card_id) : null;
  const description = cleanText(body.description, 200);

  if (cents === null) return sendError(res, 400, "Informe um valor maior que zero");
  if (!date) return sendError(res, 400, "Data inválida");
  if (!Number.isInteger(fromAccountId)) return sendError(res, 400, "Informe a conta de origem");
  if (!toAccountId && !toCardId) {
    return sendError(res, 400, "Informe a conta ou o cartão de destino");
  }
  if (toAccountId && toCardId) {
    return sendError(res, 400, "Escolha apenas um destino");
  }
  if (toAccountId && toAccountId === fromAccountId) {
    return sendError(res, 400, "A conta de destino precisa ser diferente da origem");
  }

  try {
    const rows = await withTransaction(async (client) => {
      const origin = await client.query(
        "SELECT name FROM accounts WHERE id = $1 AND user_id = $2",
        [fromAccountId, req.userId],
      );
      if (origin.rows.length === 0) throw new Error("ORIGEM");

      let destinationName: string;
      if (toAccountId) {
        const destination = await client.query(
          "SELECT name FROM accounts WHERE id = $1 AND user_id = $2",
          [toAccountId, req.userId],
        );
        if (destination.rows.length === 0) throw new Error("DESTINO");
        destinationName = destination.rows[0].name;
      } else {
        const destination = await client.query(
          "SELECT name FROM cards WHERE id = $1 AND user_id = $2",
          [toCardId, req.userId],
        );
        if (destination.rows.length === 0) throw new Error("DESTINO");
        destinationName = destination.rows[0].name;
      }

      const transferId = crypto.randomUUID();
      const amount = centsToDecimal(cents);
      const label =
        description ??
        (toCardId
          ? `Pagamento de fatura ${destinationName}`
          : `Transferência para ${destinationName}`);

      const out = await client.query(
        `INSERT INTO transactions
           (amount, type, description, date, purchase_date, payment_method, user_id, account_id, transfer_id)
         VALUES ($1, 'despesa', $2, $3, $3, 'dinheiro', $4, $5, $6) RETURNING *`,
        [amount, label, date, req.userId, fromAccountId, transferId],
      );

      const inLabel = description ?? `Transferência de ${origin.rows[0].name}`;
      const income = await client.query(
        `INSERT INTO transactions
           (amount, type, description, date, purchase_date, payment_method, user_id, account_id, card_id, transfer_id)
         VALUES ($1, 'receita', $2, $3, $3, 'dinheiro', $4, $5, $6, $7) RETURNING *`,
        [amount, inLabel, date, req.userId, toAccountId, toCardId, transferId],
      );

      return { transferId, transactions: [out.rows[0], income.rows[0]] };
    });

    res.status(201).json(rows);
  } catch (error) {
    if (error instanceof Error && error.message === "ORIGEM") {
      return sendError(res, 404, "Conta de origem não encontrada");
    }
    if (error instanceof Error && error.message === "DESTINO") {
      return sendError(res, 404, "Destino não encontrado");
    }
    console.error(error);
    sendError(res, 500, "Erro ao criar transferência");
  }
};

export const deleteTransfer = async (req: AuthRequest, res: Response) => {
  const { transferId } = req.params;
  if (typeof transferId !== "string" || !/^[0-9a-f-]{36}$/i.test(transferId)) {
    return sendError(res, 400, "Identificador de transferência inválido");
  }

  try {
    const result = await withTransaction((client) =>
      client.query("DELETE FROM transactions WHERE transfer_id = $1 AND user_id = $2", [
        transferId,
        req.userId,
      ]),
    );
    if (result.rowCount === 0) return sendError(res, 404, "Transferência não encontrada");
    res.json({ deleted: result.rowCount });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao excluir transferência");
  }
};
