import { Response } from "express";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import {
  SAVINGS_START_DATE,
  getCalculatedSavings,
  getSavingsAdjustment,
} from "../services/savings";
import { parseMonth, sendError } from "../utils/validation";

const INVALID_MONTH = 'Parâmetro "month" é obrigatório (ex: 2026-06)';

export const getSummary = async (req: AuthRequest, res: Response) => {
  const monthStart = parseMonth(req.query.month);
  if (!monthStart) return sendError(res, 400, INVALID_MONTH);

  try {
    const [periodResult, previousResult, goalResult, calculated, adjustment] =
      await Promise.all([
        pool.query(
          `SELECT
            COALESCE(SUM(amount) FILTER (WHERE type = 'receita'), 0) AS entradas,
            COALESCE(SUM(amount) FILTER (WHERE type = 'despesa'), 0) AS saidas,
            COALESCE(SUM(amount) FILTER (WHERE type = 'despesa' AND payment_method = 'credito'), 0) AS cartao,
            COUNT(*)::int AS quantidade
           FROM transactions
           WHERE user_id = $1 AND transfer_id IS NULL
             AND date >= $2::date AND date < ($2::date + INTERVAL '1 month')`,
          [req.userId, monthStart],
        ),
        pool.query(
          `SELECT
            COALESCE(SUM(amount) FILTER (WHERE type = 'receita'), 0) AS entradas,
            COALESCE(SUM(amount) FILTER (WHERE type = 'despesa'), 0) AS saidas
           FROM transactions
           WHERE user_id = $1 AND transfer_id IS NULL
             AND date >= ($2::date - INTERVAL '1 month') AND date < $2::date`,
          [req.userId, monthStart],
        ),
        pool.query(
          "SELECT savings_goal FROM monthly_goals WHERE user_id = $1 AND month_ref = $2::date",
          [req.userId, monthStart],
        ),
        getCalculatedSavings(req.userId),
        getSavingsAdjustment(req.userId),
      ]);

    const period = periodResult.rows[0];
    const entradas = parseFloat(period.entradas);
    const saidas = parseFloat(period.saidas);
    const saldoPeriodo = entradas - saidas;
    const taxaEconomia = entradas > 0 ? (saldoPeriodo / entradas) * 100 : 0;
    const savingsGoal = goalResult.rows[0]
      ? parseFloat(goalResult.rows[0].savings_goal)
      : 0;

    res.json({
      saldoGeralAcumulado: calculated + adjustment,
      savingsStartDate: SAVINGS_START_DATE,
      entradasPeriodo: entradas,
      saidasPeriodo: saidas,
      saldoPeriodo,
      taxaEconomia: parseFloat(taxaEconomia.toFixed(1)),
      savingsGoal,
      availableToSpend: entradas - savingsGoal - saidas,
      cartaoCreditoPeriodo: parseFloat(period.cartao),
      quantidadeLancamentos: period.quantidade,
      mesAnterior: {
        entradas: parseFloat(previousResult.rows[0].entradas),
        saidas: parseFloat(previousResult.rows[0].saidas),
      },
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao calcular resumo do dashboard");
  }
};

/**
 * Entradas e saídas mês a mês numa única consulta.
 * ?from=2026-04&months=6 -> abril a setembro.
 */
export const getEvolution = async (req: AuthRequest, res: Response) => {
  const fromStart = parseMonth(req.query.from);
  const months = Number(req.query.months ?? 6);
  if (!fromStart || !Number.isInteger(months) || months < 1 || months > 24) {
    return sendError(res, 400, 'Parâmetros inválidos (ex: from=2026-04&months=6)');
  }

  try {
    const result = await pool.query(
      `SELECT
         to_char(m.month_start, 'YYYY-MM') AS month,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'receita'), 0) AS entradas,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'despesa'), 0) AS saidas
       FROM generate_series($2::date, $2::date + ($3::int - 1) * INTERVAL '1 month', INTERVAL '1 month') AS m(month_start)
       LEFT JOIN transactions t
         ON t.user_id = $1
        AND t.transfer_id IS NULL
        AND t.date >= m.month_start
        AND t.date < m.month_start + INTERVAL '1 month'
       GROUP BY m.month_start
       ORDER BY m.month_start`,
      [req.userId, fromStart, months],
    );

    res.json(
      result.rows.map((row) => {
        const entradas = parseFloat(row.entradas);
        const saidas = parseFloat(row.saidas);
        return { month: row.month, entradas, saidas, saldo: entradas - saidas };
      }),
    );
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao calcular evolução");
  }
};

export const getDistribution = async (req: AuthRequest, res: Response) => {
  const monthStart = parseMonth(req.query.month);
  if (!monthStart) return sendError(res, 400, INVALID_MONTH);

  try {
    // Parte do lançamento (e não da categoria) para incluir gastos sem categoria.
    const result = await pool.query(
      `SELECT
        c.id AS category_id,
        COALESCE(c.name, 'Sem categoria') AS name,
        COALESCE(c.color, '#94A3B8') AS color,
        SUM(t.amount) AS total
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
         AND t.transfer_id IS NULL
         AND t.type = 'despesa'
         AND t.date >= $2::date AND t.date < ($2::date + INTERVAL '1 month')
       GROUP BY c.id, c.name, c.color
       ORDER BY total DESC`,
      [req.userId, monthStart],
    );

    const totalGeral = result.rows.reduce(
      (acc, row) => acc + parseFloat(row.total),
      0,
    );

    res.json(
      result.rows.map((row) => ({
        categoryId: row.category_id,
        name: row.name,
        color: row.color,
        total: parseFloat(row.total),
        percentage:
          totalGeral > 0 ? Math.round((parseFloat(row.total) / totalGeral) * 100) : 0,
      })),
    );
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao calcular distribuição por categoria");
  }
};
