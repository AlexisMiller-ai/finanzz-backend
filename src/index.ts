import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool } from "./config/db";
import categoriesRoutes from "./routes/categories";
import transactionsRoutes from "./routes/transactions";
import dashboardRoutes from "./routes/dashboard";
import budgetsRoutes from "./routes/budgets";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use("/categories", categoriesRoutes);
app.use("/transactions", transactionsRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/budgets", budgetsRoutes);

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

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
