import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { pool, withTransaction } from "../config/db";
import { generateToken } from "../config/jwt";
import { AuthRequest } from "../middleware/auth";
import {
  LIMITES,
  bloqueadoPor,
  ipDoCliente,
  limparTentativas,
  mensagemDeEspera,
  registrarTentativa,
} from "../services/rateLimit";
import { cleanText, sendError } from "../utils/validation";

const DEFAULT_CATEGORIES = [
  { name: "Alimentação", type: "despesa", color: "#EF4444" },
  { name: "Moradia", type: "despesa", color: "#3B82F6" },
  { name: "Transporte", type: "despesa", color: "#F59E0B" },
  { name: "Saúde", type: "despesa", color: "#10B981" },
  { name: "Lazer & Viagem", type: "despesa", color: "#8B5CF6" },
  { name: "Assinaturas", type: "despesa", color: "#EC4899" },
  { name: "Educação", type: "despesa", color: "#06B6D4" },
  { name: "Compras", type: "despesa", color: "#F97316" },
  { name: "Salário", type: "receita", color: "#16A34A" },
  { name: "Freelance", type: "receita", color: "#0EA5E9" },
  { name: "Outras Receitas", type: "receita", color: "#22C55E" },
];

const MIN_PASSWORD_LENGTH = 8;

/**
 * Hash usado quando o e-mail não existe: o login gasta o mesmo tempo com ou
 * sem conta, e o tempo de resposta não entrega quais e-mails estão cadastrados.
 */
const HASH_FALSO = bcrypt.hashSync("senha-que-nao-existe", 10);

function bloqueado(res: Response, segundos: number) {
  res.set("Retry-After", String(segundos));
  return sendError(res, 429, mensagemDeEspera(segundos));
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 150
    ? email
    : null;
}

export const register = async (req: Request, res: Response) => {
  const name = cleanText(req.body?.name, 100);
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;

  if (!name || !email || typeof password !== "string") {
    return sendError(res, 400, "Informe nome, e-mail válido e senha");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return sendError(
      res,
      400,
      `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres`,
    );
  }

  try {
    const chaveIp = `cadastro:ip:${ipDoCliente(req)}`;
    const espera = await bloqueadoPor(chaveIp, LIMITES.cadastroPorIp);
    if (espera) return bloqueado(res, espera);

    const existing = await pool.query(
      "SELECT id FROM users WHERE LOWER(email) = $1",
      [email],
    );
    if (existing.rows.length > 0) {
      return sendError(res, 409, "Este e-mail já está cadastrado");
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await withTransaction(async (client) => {
      const result = await client.query(
        "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email",
        [name, email, passwordHash],
      );
      const created = result.rows[0];

      for (const category of DEFAULT_CATEGORIES) {
        await client.query(
          "INSERT INTO categories (name, type, color, user_id) VALUES ($1, $2, $3, $4)",
          [category.name, category.type, category.color, created.id],
        );
      }

      // Toda conta nasce com uma conta de dinheiro, senão não há onde lançar.
      await client.query(
        "INSERT INTO accounts (user_id, name, kind) VALUES ($1, $2, $3)",
        [created.id, "Conta principal", "corrente"],
      );

      return created;
    });

    await registrarTentativa(chaveIp);
    res.status(201).json({ user, token: generateToken(user.id) });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao criar conta");
  }
};

export const login = async (req: Request, res: Response) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;

  if (!email || typeof password !== "string" || !password) {
    return sendError(res, 400, "Informe e-mail e senha");
  }

  const chaveEmail = `login:email:${email}`;
  const chaveIp = `login:ip:${ipDoCliente(req)}`;

  try {
    const espera =
      (await bloqueadoPor(chaveEmail, LIMITES.loginPorEmail)) ??
      (await bloqueadoPor(chaveIp, LIMITES.loginPorIp));
    if (espera) return bloqueado(res, espera);

    const result = await pool.query(
      "SELECT id, name, email, password_hash FROM users WHERE LOWER(email) = $1",
      [email],
    );
    const user = result.rows[0];
    const senhaConfere = await bcrypt.compare(password, user?.password_hash ?? HASH_FALSO);

    if (!user || !senhaConfere) {
      await registrarTentativa(chaveEmail, chaveIp);
      return sendError(res, 401, "E-mail ou senha inválidos");
    }

    await limparTentativas(chaveEmail);
    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      token: generateToken(user.id),
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao fazer login");
  }
};

export const me = async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email FROM users WHERE id = $1",
      [req.userId],
    );
    if (result.rows.length === 0) {
      return sendError(res, 404, "Usuário não encontrado");
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao buscar usuário");
  }
};

export const updateProfile = async (req: AuthRequest, res: Response) => {
  const name = cleanText(req.body?.name, 100);
  if (!name) {
    return sendError(res, 400, "Informe o nome");
  }

  try {
    const result = await pool.query(
      "UPDATE users SET name = $1 WHERE id = $2 RETURNING id, name, email",
      [name, req.userId],
    );
    if (result.rows.length === 0) {
      return sendError(res, 404, "Usuário não encontrado");
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao atualizar perfil");
  }
};

export const changePassword = async (req: AuthRequest, res: Response) => {
  const { current_password, new_password } = req.body ?? {};

  if (typeof current_password !== "string" || typeof new_password !== "string") {
    return sendError(res, 400, "Informe a senha atual e a nova senha");
  }
  if (new_password.length < MIN_PASSWORD_LENGTH) {
    return sendError(
      res,
      400,
      `A nova senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres`,
    );
  }

  try {
    const result = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.userId],
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(current_password, user.password_hash))) {
      return sendError(res, 400, "Senha atual incorreta");
    }

    const passwordHash = await bcrypt.hash(new_password, 10);
    // Tokens emitidos antes deste segundo deixam de valer (ver middleware/auth).
    await pool.query(
      "UPDATE users SET password_hash = $1, password_changed_at = date_trunc('second', now()) WHERE id = $2",
      [passwordHash, req.userId],
    );
    // Quem trocou a senha continua logado neste aparelho com um token novo;
    // os outros aparelhos são desconectados.
    res.json({ token: generateToken(req.userId as number) });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Erro ao alterar senha");
  }
};
