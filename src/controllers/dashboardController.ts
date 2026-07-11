import { Request, Response } from "express";
import { pool } from "../config/db";

export const getSummary = async (req: Request, res: Response) => {
  const { month } = req.query; // formato esperado: "2026-06"

  if (!month) {
    return res
      .status(400)
      .json({
        status: "error",
        message: 'Parâmetro "month" é obrigatório (ex: 2026-06)',
      });
  }

  try {
    // Entradas e saídas DO MÊS filtrado
    const periodResult = await pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'receita' THEN amount END), 0) AS entradas,
        COALESCE(SUM(CASE WHEN type = 'despesa' THEN amount END), 0) AS saidas
       FROM transactions
       WHERE date >= $1::date AND date < ($1::date + INTERVAL '1 month')`,
      [`${month}-01`],
    );

    const entradas = parseFloat(periodResult.rows[0].entradas);
    const saidas = parseFloat(periodResult.rows[0].saidas);
    const saldoPeriodo = entradas - saidas;
    const taxaEconomia = entradas > 0 ? (saldoPeriodo / entradas) * 100 : 0;

    // Saldo GERAL acumulado (todos os meses, desde o início)
    const totalResult = await pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'receita' THEN amount END), 0) AS total_entradas,
        COALESCE(SUM(CASE WHEN type = 'despesa' THEN amount END), 0) AS total_saidas
       FROM transactions`,
    );

    const totalEntradas = parseFloat(totalResult.rows[0].total_entradas);
    const totalSaidas = parseFloat(totalResult.rows[0].total_saidas);
    const saldoGeral = totalEntradas - totalSaidas;

    res.json({
      saldoGeralAcumulado: saldoGeral,
      entradasPeriodo: entradas,
      saidasPeriodo: saidas,
      saldoPeriodo,
      taxaEconomia: parseFloat(taxaEconomia.toFixed(1)),
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({
        status: "error",
        message: "Erro ao calcular resumo do dashboard",
      });
  }
};

export const getDistribution = async (req: Request, res: Response) => {
  const { month } = req.query;

  if (!month) {
    return res
      .status(400)
      .json({
        status: "error",
        message: 'Parâmetro "month" é obrigatório (ex: 2026-06)',
      });
  }

  try {
    const result = await pool.query(
      `SELECT
        c.id AS category_id,
        c.name,
        c.color,
        COALESCE(SUM(t.amount), 0) AS total
       FROM categories c
       LEFT JOIN transactions t
         ON t.category_id = c.id
         AND t.type = 'despesa'
         AND t.date >= $1::date AND t.date < ($1::date + INTERVAL '1 month')
       GROUP BY c.id, c.name, c.color
       HAVING COALESCE(SUM(t.amount), 0) > 0
       ORDER BY total DESC`,
      [`${month}-01`],
    );

    const totalGeral = result.rows.reduce(
      (acc, row) => acc + parseFloat(row.total),
      0,
    );

    const distribution = result.rows.map((row) => ({
      categoryId: row.category_id,
      name: row.name,
      color: row.color,
      total: parseFloat(row.total),
      percentage:
        totalGeral > 0
          ? parseFloat(((parseFloat(row.total) / totalGeral) * 100).toFixed(0))
          : 0,
    }));

    res.json(distribution);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({
        status: "error",
        message: "Erro ao calcular distribuição por categoria",
      });
  }
};
