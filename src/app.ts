import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool } from "./config/db";
import authRoutes from "./routes/auth";
import categoriesRoutes from "./routes/categories";
import transactionsRoutes from "./routes/transactions";
import dashboardRoutes from "./routes/dashboard";
import budgetsRoutes from "./routes/budgets";
import goalsRoutes from "./routes/goals";
import savingsRoutes from "./routes/savings";
import { authenticate } from "./middleware/auth";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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

app.get("/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ status: "ok", dbTime: result.rows[0].now });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ status: "error", message: "Falha ao conectar no banco" });
  }
});

export default app;
