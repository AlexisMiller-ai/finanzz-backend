import { Response } from "express";
import { withTransaction } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { centsToDecimal, cleanText, sendError, toCents } from "../utils/validation";

const MAX_ITEMS = 500;

/**
 * Marca lançamentos que o usuário já tinha cadastrado na mão como sendo o mesmo
 * gasto que veio do arquivo do banco. Guarda o identificador da origem para o
 * item não reaparecer em importações futuras e, se pedido, corrige o valor.
 */
export const reconcileTransactions = async (req: AuthRequest, res: Response) => {
  const items = req.body?.items;

  if (!Array.isArray(items) || items.length === 0) {
    return sendError(res, 400, "Envie ao menos um lançamento para conciliar");
  }
  if (items.length > MAX_ITEMS) {
    return sendError(res, 400, `Concilie no máximo ${MAX_ITEMS} lançamentos por vez`);
  }

  try {
    const result = await withTransaction(async (client) => {
      let reconciled = 0;
      let amountsFixed = 0;
      const skipped: { transaction_id: unknown; reason: string }[] = [];

      for (const item of items) {
        const id = Number(item?.transaction_id);
        const externalId = cleanText(item?.external_id, 80);

        if (!Number.isInteger(id) || !externalId) {
          skipped.push({ transaction_id: item?.transaction_id, reason: "Dados inválidos" });
          continue;
        }

        const current = await client.query(
          "SELECT id, external_id FROM transactions WHERE id = $1 AND user_id = $2",
          [id, req.userId],
        );
        const row = current.rows[0];
        if (!row) {
          skipped.push({ transaction_id: id, reason: "Lançamento não encontrado" });
          continue;
        }
        if (row.external_id) {
          skipped.push({ transaction_id: id, reason: "Já conciliado antes" });
          continue;
        }

        // O identificador pode já pertencer a outro lançamento (arquivo repetido).
        const taken = await client.query(
          "SELECT id FROM transactions WHERE user_id = $1 AND external_id = $2",
          [req.userId, externalId],
        );
        if (taken.rows.length > 0) {
          skipped.push({ transaction_id: id, reason: "Esse item do banco já está conciliado" });
          continue;
        }

        const cents = item?.amount === undefined ? null : toCents(item.amount);
        if (item?.amount !== undefined && cents === null) {
          skipped.push({ transaction_id: id, reason: "Valor inválido" });
          continue;
        }

        if (cents !== null) {
          await client.query(
            "UPDATE transactions SET external_id = $1, amount = $2 WHERE id = $3 AND user_id = $4",
            [externalId, centsToDecimal(cents), id, req.userId],
          );
          amountsFixed++;
        } else {
          await client.query(
            "UPDATE transactions SET external_id = $1 WHERE id = $2 AND user_id = $3",
            [externalId, id, req.userId],
          );
        }
        reconciled++;
      }

      return { reconciled, amountsFixed, skipped };
    });

    res.json(result);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao conciliar lançamentos");
  }
};
