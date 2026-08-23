import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middleware/auth';

export const updateSavingsAdjustment = async (req: AuthRequest, res: Response) => {
  const { manual_total } = req.body;

  if (manual_total === undefined) {
    return res.status(400).json({ status: 'error', message: 'Campo obrigatório: manual_total' });
  }

  try {
    // Busca o saldo calculado automaticamente (entradas - saídas de todas as transações)
    const totalResult = await pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'receita' THEN amount END), 0) AS total_entradas,
        COALESCE(SUM(CASE WHEN type = 'despesa' THEN amount END), 0) AS total_saidas
       FROM transactions
       WHERE user_id = $1 AND date >= '2026-08-01'::date`,
      [req.userId]
    );

    const totalEntradas = parseFloat(totalResult.rows[0].total_entradas);
    const totalSaidas = parseFloat(totalResult.rows[0].total_saidas);
    const calculatedTotal = totalEntradas - totalSaidas;

    // O ajuste é a diferença entre o que o usuário quer mostrar e o que foi calculado
    const adjustment = parseFloat(manual_total) - calculatedTotal;

    const result = await pool.query(
      'UPDATE users SET savings_adjustment = $1 WHERE id = $2 RETURNING savings_adjustment',
      [adjustment, req.userId]
    );

    res.json({ savingsAdjustment: parseFloat(result.rows[0].savings_adjustment) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: 'Erro ao atualizar valor guardado' });
  }
};