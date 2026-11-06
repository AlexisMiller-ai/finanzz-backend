import { Response } from "express";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { getCalculatedSavings } from "../services/savings";
import { parseDate, sendError } from "../utils/validation";

/**
 * Ajusta o "Total guardado". Aceita os dois campos, juntos ou separados:
 *   start_date   -> de quando contar ("YYYY-MM-DD", ou null = desde o primeiro lançamento)
 *   manual_total -> quanto a pessoa tem guardado hoje; vira o ajuste em relação ao calculado
 * Mudar só a data muda o cálculo e mantém o ajuste que já existia.
 */
export const updateSavingsAdjustment = async (req: AuthRequest, res: Response) => {
  const body = req.body ?? {};
  const mudaData = body.start_date !== undefined;
  const mudaTotal = body.manual_total !== undefined;
  if (!mudaData && !mudaTotal) {
    return sendError(res, 400, "Informe manual_total e/ou start_date");
  }

  const manualTotal = Number(body.manual_total);
  if (mudaTotal && !Number.isFinite(manualTotal)) {
    return sendError(res, 400, "Valor guardado inválido");
  }
  const startDate = body.start_date === null ? null : parseDate(body.start_date);
  if (mudaData && body.start_date !== null && !startDate) {
    return sendError(res, 400, "Data de início inválida");
  }

  try {
    if (mudaData) {
      await pool.query("UPDATE users SET savings_start_date = $1 WHERE id = $2", [
        startDate,
        req.userId,
      ]);
    }

    const calculated = await getCalculatedSavings(req.userId);
    let adjustment: number;
    if (mudaTotal) {
      // O ajuste é a diferença entre o valor real informado e o calculado.
      adjustment = Math.round((manualTotal - calculated) * 100) / 100;
      await pool.query("UPDATE users SET savings_adjustment = $1 WHERE id = $2", [
        adjustment,
        req.userId,
      ]);
    } else {
      const atual = await pool.query("SELECT savings_adjustment FROM users WHERE id = $1", [
        req.userId,
      ]);
      adjustment = parseFloat(atual.rows[0]?.savings_adjustment ?? 0);
    }

    res.json({
      savingsAdjustment: adjustment,
      savingsStartDate: mudaData ? startDate : undefined,
      total: Math.round((calculated + adjustment) * 100) / 100,
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao atualizar valor guardado");
  }
};
