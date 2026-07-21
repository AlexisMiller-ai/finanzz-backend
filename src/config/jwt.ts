import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "troque_essa_chave_em_producao";

export function generateToken(userId: number) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
}

export function verifyToken(token: string): { userId: number } {
  return jwt.verify(token, JWT_SECRET) as { userId: number };
}
