import { Response } from "express";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { billDueDate, openBillMonth } from "../utils/bills";
import { parseDate, sendError, todayInBrazil } from "../utils/validation";

/**
 * Contas a pagar e a receber: o que está pendente e já venceu, mais o que
 * vence nos próximos dias. Junta duas origens — lançamentos marcados como
 * pendentes e faturas de cartão que fecharam sem baixa.
 */

const DIAS_PADRAO = 7;
const DIAS_MAX = 90;

type Item = {
  tipo: "lancamento" | "fatura";
  id: number | string;
  descricao: string;
  valor: number;
  movimento: "despesa" | "receita";
  vencimento: string;
  /** Negativo = já venceu; 0 = vence hoje. */
  emDias: number;
  origem: string | null;
  cardId?: number;
  /** Mês de referência da fatura ("YYYY-MM"). */
  mes?: string;
};

const diasEntre = (de: string, ate: string) =>
  Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000);

export const getUpcoming = async (req: AuthRequest, res: Response) => {
  const dias = req.query.days === undefined ? DIAS_PADRAO : Number(req.query.days);
  if (!Number.isInteger(dias) || dias < 0 || dias > DIAS_MAX) {
    return sendError(res, 400, `Parâmetro "days" inválido (0 a ${DIAS_MAX})`);
  }
  const hoje = parseDate(req.query.today) ?? todayInBrazil();

  try {
    const [pendentes, faturas] = await Promise.all([
      pool.query(
        `SELECT t.id, t.description, t.amount, t.type, t.date,
                a.name AS account_name
           FROM transactions t
           LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.user_id = $1 AND NOT t.settled
          ORDER BY t.date, t.id`,
        [req.userId],
      ),
      // Faturas que já fecharam e seguem sem baixa, mês a mês.
      pool.query(
        `SELECT c.id AS card_id, c.name AS card_name, c.closing_day, c.due_day,
                to_char(t.date, 'YYYY-MM') AS mes,
                SUM(CASE WHEN t.type = 'despesa' THEN t.amount ELSE -t.amount END) AS total
           FROM cards c
           JOIN transactions t ON t.card_id = c.id AND t.user_id = c.user_id
          WHERE c.user_id = $1 AND NOT c.archived
            AND NOT EXISTS (
              SELECT 1 FROM card_bills b
               WHERE b.card_id = c.id AND b.bill_month = date_trunc('month', t.date)::date
            )
          GROUP BY c.id, c.name, c.closing_day, c.due_day, to_char(t.date, 'YYYY-MM')
         HAVING SUM(CASE WHEN t.type = 'despesa' THEN t.amount ELSE -t.amount END) > 0`,
        [req.userId],
      ),
    ]);

    const itens: Item[] = pendentes.rows.map((row) => ({
      tipo: "lancamento",
      id: row.id,
      descricao: row.description ?? (row.type === "receita" ? "Entrada" : "Saída"),
      valor: parseFloat(row.amount),
      movimento: row.type,
      vencimento: row.date,
      emDias: diasEntre(hoje, row.date),
      origem: row.account_name,
    }));

    for (const row of faturas.rows) {
      const mes = row.mes as string;
      const abertaEm = openBillMonth(row.closing_day, hoje).slice(0, 7);
      // A fatura aberta ainda está recebendo compras: só cobra quando fecha.
      if (mes >= abertaEm) continue;
      const vencimento = billDueDate(`${mes}-01`, row.closing_day, row.due_day) ?? `${mes}-01`;
      itens.push({
        tipo: "fatura",
        id: `${row.card_id}-${mes}`,
        descricao: `Fatura ${row.card_name}`,
        valor: parseFloat(row.total),
        movimento: "despesa",
        vencimento,
        emDias: diasEntre(hoje, vencimento),
        origem: row.card_name,
        cardId: row.card_id,
        mes,
      });
    }

    const vencidos = itens.filter((item) => item.emDias < 0).sort((a, b) => a.emDias - b.emDias);
    const proximos = itens
      .filter((item) => item.emDias >= 0 && item.emDias <= dias)
      .sort((a, b) => a.emDias - b.emDias);
    const depois = itens.filter((item) => item.emDias > dias).length;

    const somar = (lista: Item[], movimento: Item["movimento"]) =>
      Math.round(
        lista
          .filter((item) => item.movimento === movimento)
          .reduce((total, item) => total + item.valor, 0) * 100,
      ) / 100;

    res.json({
      dias,
      vencidos,
      proximos,
      aindaMaisTarde: depois,
      totais: {
        aPagarVencido: somar(vencidos, "despesa"),
        aReceberVencido: somar(vencidos, "receita"),
        aPagarProximos: somar(proximos, "despesa"),
        aReceberProximos: somar(proximos, "receita"),
      },
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao buscar o que está por vencer");
  }
};
