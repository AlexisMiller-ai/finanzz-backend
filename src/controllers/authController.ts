import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../config/db";
import { generateToken } from "../config/jwt";

const DEFAULT_CATEGORIES = [
  { name: "Alimentação", type: "despesa", color: "#EF4444" },
  { name: "Moradia", type: "despesa", color: "#3B82F6" },
  { name: "Transporte", type: "despesa", color: "#F59E0B" },
  { name: "Saúde", type: "despesa", color: "#10B981" },
  { name: "Lazer & Viagem", type: "despesa", color: "#8B5CF6" },
  { name: "Salário", type: "receita", color: "#16A34A" },
  { name: "Freelance", type: "receita", color: "#0EA5E9" },
  { name: "Outras Receitas", type: "receita", color: "#22C55E" },
];

export const register = async (req: Request, res: Response) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res
      .status(400)
      .json({
        status: "error",
        message: "Campos obrigatórios: name, email, password",
      });
  }

  try {
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [
      email,
    ]);
    if (existing.rows.length > 0) {
      return res
        .status(409)
        .json({ status: "error", message: "Este e-mail já está cadastrado" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email",
      [name, email, passwordHash],
    );

    const user = result.rows[0];

    // Cria categorias padrão para o novo usuário
    for (const category of DEFAULT_CATEGORIES) {
      await pool.query(
        "INSERT INTO categories (name, type, color, user_id) VALUES ($1, $2, $3, $4)",
        [category.name, category.type, category.color, user.id],
      );
    }

    const token = generateToken(user.id);

    res.status(201).json({ user, token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "error", message: "Erro ao criar conta" });
  }
};

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res
      .status(400)
      .json({ status: "error", message: "Informe e-mail e senha" });
  }

  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);
    const user = result.rows[0];

    if (!user) {
      return res
        .status(401)
        .json({ status: "error", message: "E-mail ou senha inválidos" });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res
        .status(401)
        .json({ status: "error", message: "E-mail ou senha inválidos" });
    }

    const token = generateToken(user.id);

    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      token,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "error", message: "Erro ao fazer login" });
  }
};

export const me = async (req: Request & { userId?: number }, res: Response) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email FROM users WHERE id = $1",
      [req.userId],
    );
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Usuário não encontrado" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Erro ao buscar usuário" });
  }
};
