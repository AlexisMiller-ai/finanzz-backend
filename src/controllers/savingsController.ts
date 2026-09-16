import { Response } from "express";
import { pool } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { getCalculatedSavings } from "../services/savings";
import { sendError } from "../utils/validation";

export const updateSavingsAdjustment = async (req: AuthRequest, res: Response) => {
  const manualTotal = Number(req.body?.manual_total);

  if (req.body?.manual_total === undefined || !Number.isFinite(manualTotal)) {
    return sendError(res, 400, "Campo obrigatório: manual_total");
  }

  try {
    // O ajuste é a diferença entre o valor real informado e o calculado.
    const calculated = await getCalculatedSavings(req.userId);
    const adjustment = Math.round((manualTotal - calculated) * 100) / 100;

    const result = await pool.query(
      "UPDATE users SET savings_adjustment = $1 WHERE id = $2 RETURNING savings_adjustment",
      [adjustment, req.userId],
    );

    res.json({
      savingsAdjustment: parseFloat(result.rows[0].savings_adjustment),
      total: calculated + adjustment,
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao atualizar valor guardado");
  }
};
