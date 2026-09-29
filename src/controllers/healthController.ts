import { Request, Response } from "express";
import { pool } from "../config/db";
import { sendError } from "../utils/validation";

const DAY_MS = 24 * 60 * 60 * 1000;
/** O plano free do Supabase pausa o projeto após 7 dias sem atividade. */
const PAUSE_AFTER_DAYS = 7;

export const health = async (_req: Request, res: Response) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ status: "ok", dbTime: result.rows[0].now });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Falha ao conectar no banco");
  }
};

/**
 * Mantém o banco ativo: grava um registro de atividade a cada chamada.
 * Chamado pelo cron da Vercel e pelo workflow do GitHub Actions.
 * Se CRON_SECRET estiver definido, exige "Authorization: Bearer <segredo>".
 */
export const keepAlive = async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return sendError(res, 401, "Não autorizado");
  }

  const source = String(req.query.source ?? "desconhecido").slice(0, 40);

  try {
    // Escrita (não só leitura) para valer como atividade de verdade no banco.
    const result = await pool.query(
      `UPDATE app_heartbeat
         SET previous_ping = last_ping,
             last_ping = now(),
             source = $1,
             ping_count = ping_count + 1
       WHERE id = 1
       RETURNING last_ping, previous_ping, ping_count`,
      [source],
    );

    const row = result.rows[0];
    if (!row) {
      return sendError(res, 500, "Registro de atividade não encontrado (rode as migrations)");
    }

    const previous = row.previous_ping ? new Date(row.previous_ping) : null;
    const gapDays = previous
      ? Math.round(((Date.now() - previous.getTime()) / DAY_MS) * 10) / 10
      : null;

    // Se o intervalo passou perto do limite, os agendadores podem ter falhado.
    if (gapDays !== null && gapDays >= PAUSE_AFTER_DAYS - 2) {
      console.warn(
        `[keep-alive] ${gapDays} dias desde o último sinal (limite de pausa: ${PAUSE_AFTER_DAYS})`,
      );
    }

    res.json({
      status: "ok",
      source,
      lastPing: row.last_ping,
      previousPing: row.previous_ping,
      daysSincePreviousPing: gapDays,
      pauseAfterDays: PAUSE_AFTER_DAYS,
      pingCount: Number(row.ping_count),
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Falha ao registrar atividade no banco");
  }
};
