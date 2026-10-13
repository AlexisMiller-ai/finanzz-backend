import { Router } from "express";
import {
  getBudgets,
  createBudget,
  copyBudgets,
  deleteBudget,
  getSuggestions,
  stopBudget,
} from "../controllers/budgetsController";

const router = Router();

router.get("/", getBudgets); // ?month=YYYY-MM — o que vale naquele mês
router.get("/suggestions", getSuggestions); // limites pela média dos 3 meses anteriores
router.post("/", createBudget); // body.scope: daqui_pra_frente (padrão) | so_este_mes
router.post("/copy", copyBudgets);
router.delete("/category/:categoryId", stopBudget); // ?month=&scope= encerra o orçamento
router.delete("/:id", deleteBudget);

export default router;
