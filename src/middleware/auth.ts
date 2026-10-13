import { Request, Response, NextFunction } from "express";
import { pool } from "../config/db";
import { verifyToken } from "../config/jwt";
import { sendError } from "../utils/validation";

export interface AuthRequest extends Request {
  userId?: number;
}

/**
 * Exige um token válido. Além da assinatura, confere no banco que o usuário
 * ainda existe e que o token é posterior à última troca de senha — trocar a
 * senha desconecta os outros aparelhos.
 */
export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!token) return sendError(res, 401, "Token não fornecido");

  let payload: { userId: number; iat?: number };
  try {
    payload = verifyToken(token) as { userId: number; iat?: number };
  } catch {
    return sendError(res, 401, "Token inválido ou expirado");
  }

  try {
    const result = await pool.query(
      "SELECT EXTRACT(EPOCH FROM password_changed_at)::bigint AS trocada_em FROM users WHERE id = $1",
      [payload.userId],
    );
    const usuario = result.rows[0];
    if (!usuario) return sendError(res, 401, "Sessão inválida");
    const trocadaEm = usuario.trocada_em === null ? null : Number(usuario.trocada_em);
    if (trocadaEm !== null && (payload.iat ?? 0) < trocadaEm) {
      return sendError(res, 401, "A senha foi alterada. Entre de novo.");
    }
  } catch (error) {
    console.error(error);
    return sendError(res, 503, "Não foi possível validar a sessão agora");
  }

  req.userId = payload.userId;
  next();
}
