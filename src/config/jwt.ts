import jwt from "jsonwebtoken";

// Chave que assina os tokens de login. Quem a conhece consegue forjar um token
// para qualquer usuário, então em produção ela só pode vir do ambiente — nunca
// do código, que é público.
const DEV_SECRET = "chave_de_desenvolvimento_nao_use_em_producao";
const MIN_LENGTH = 32;

const isProduction =
  process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";

function resolveSecret(): string {
  const fromEnv = process.env.JWT_SECRET?.trim();

  if (isProduction) {
    // Falhar aqui é de propósito: configuração errada vira deploy quebrado,
    // que aparece na hora, em vez de uma brecha silenciosa.
    if (!fromEnv) {
      throw new Error(
        "[finanzz] JWT_SECRET não definido. Defina a variável de ambiente no painel da hospedagem antes de subir.",
      );
    }
    if (fromEnv === DEV_SECRET || fromEnv === "troque_essa_chave_em_producao") {
      throw new Error("[finanzz] JWT_SECRET está com o valor de exemplo. Gere uma chave própria.");
    }
    // Aqui é só aviso: derrubar a produção por causa do tamanho da chave
    // causaria mais estrago do que a chave curta.
    if (fromEnv.length < MIN_LENGTH) {
      console.warn(
        `[finanzz] JWT_SECRET tem ${fromEnv.length} caracteres; o recomendado são pelo menos ${MIN_LENGTH}.`,
      );
    }
    return fromEnv;
  }

  if (!fromEnv) {
    console.warn("[finanzz] JWT_SECRET não definido: usando chave de desenvolvimento.");
    return DEV_SECRET;
  }
  return fromEnv;
}

const JWT_SECRET = resolveSecret();

export function generateToken(userId: number) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
}

export function verifyToken(token: string): { userId: number } {
  return jwt.verify(token, JWT_SECRET) as { userId: number };
}
