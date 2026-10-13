import { Request } from "express";
import { pool } from "../config/db";

/**
 * Limite de tentativas para login e cadastro, guardado no banco: no
 * serverless cada requisição pode cair numa instância diferente, então um
 * contador em memória não seguraria nada.
 */

const numeroDoAmbiente = (nome: string, padrao: number) => {
  const valor = Number(process.env[nome]);
  return Number.isInteger(valor) && valor > 0 ? valor : padrao;
};

export const LIMITES = {
  /** Senhas erradas para o mesmo e-mail, em 15 minutos. */
  loginPorEmail: { max: numeroDoAmbiente("LOGIN_MAX_PER_EMAIL", 8), minutos: 15 },
  /** Senhas erradas vindas do mesmo IP (qualquer e-mail), em 15 minutos. */
  loginPorIp: { max: numeroDoAmbiente("LOGIN_MAX_PER_IP", 30), minutos: 15 },
  /** Contas criadas a partir do mesmo IP, em uma hora. */
  cadastroPorIp: { max: numeroDoAmbiente("REGISTER_MAX_PER_IP", 10), minutos: 60 },
};

type Limite = { max: number; minutos: number };

/**
 * IP do cliente. Na Vercel o x-forwarded-for é preenchido pela própria
 * plataforma (o valor enviado pelo cliente é descartado), então dá para
 * confiar. Fora dela, atrás de outro proxy, rever esta função.
 */
export function ipDoCliente(req: Request): string {
  const encaminhado = req.headers["x-forwarded-for"];
  const primeiro = (Array.isArray(encaminhado) ? encaminhado[0] : encaminhado)?.split(",")[0]?.trim();
  return (primeiro || req.socket.remoteAddress || "desconhecido").slice(0, 60);
}

/** Segundos até liberar, ou null se ainda pode tentar. */
export async function bloqueadoPor(chave: string, limite: Limite): Promise<number | null> {
  const resultado = await pool.query(
    `SELECT COUNT(*)::int AS tentativas,
            EXTRACT(EPOCH FROM (MIN(attempted_at) + make_interval(mins => $3) - now()))::int AS restante
       FROM auth_attempts
      WHERE key = $1 AND attempted_at > now() - make_interval(mins => $2)`,
    [chave, limite.minutos, limite.minutos],
  );
  const { tentativas, restante } = resultado.rows[0];
  return tentativas >= limite.max ? Math.max(restante ?? 60, 1) : null;
}

export async function registrarTentativa(...chaves: string[]) {
  for (const chave of chaves) {
    await pool.query("INSERT INTO auth_attempts (key) VALUES ($1)", [chave]);
  }
}

export async function limparTentativas(chave: string) {
  await pool.query("DELETE FROM auth_attempts WHERE key = $1", [chave]);
}

/** Apaga o que já não conta para limite nenhum (chamado pelo keep-alive diário). */
export async function limparTentativasAntigas() {
  await pool.query("DELETE FROM auth_attempts WHERE attempted_at < now() - INTERVAL '1 day'");
}

export function mensagemDeEspera(segundos: number) {
  const minutos = Math.ceil(segundos / 60);
  return `Muitas tentativas. Tente de novo em ${minutos} ${minutos === 1 ? "minuto" : "minutos"}.`;
}
