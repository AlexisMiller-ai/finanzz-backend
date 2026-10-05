import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/auth";
import categoriesRoutes from "./routes/categories";
import transactionsRoutes from "./routes/transactions";
import dashboardRoutes from "./routes/dashboard";
import budgetsRoutes from "./routes/budgets";
import goalsRoutes from "./routes/goals";
import savingsRoutes from "./routes/savings";
import accountsRoutes from "./routes/accounts";
import cardsRoutes from "./routes/cards";
import transfersRoutes from "./routes/transfers";
import { authenticate } from "./middleware/auth";
import { health, keepAlive } from "./controllers/healthController";
import { sendError } from "./utils/validation";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.use("/auth", authRoutes);

app.use("/categories", authenticate, categoriesRoutes);
app.use("/transactions", authenticate, transactionsRoutes);
app.use("/dashboard", authenticate, dashboardRoutes);
app.use("/budgets", authenticate, budgetsRoutes);
app.use("/goals", authenticate, goalsRoutes);
app.use("/savings", authenticate, savingsRoutes);
app.use("/accounts", authenticate, accountsRoutes);
app.use("/cards", authenticate, cardsRoutes);
app.use("/transfers", authenticate, transfersRoutes);

app.get("/health", health);

// Mantém o banco ativo (Supabase free pausa o projeto após 7 dias parado).
app.get("/keep-alive", keepAlive);
app.post("/keep-alive", keepAlive);

app.use((req, res) => {
  sendError(res, 404, "Rota não encontrada");
});

// JSON malformado e erros não tratados respondem em JSON, não em HTML.
app.use(
  (
    error: Error & { type?: string },
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error.type === "entity.parse.failed") {
      return sendError(res, 400, "JSON inválido");
    }
    console.error(error);
    sendError(res, 500, "Erro interno");
  },
);

export default app;
