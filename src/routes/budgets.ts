import { Router } from "express";
import {
  getBudgets,
  createBudget,
  copyBudgets,
  deleteBudget,
} from "../controllers/budgetsController";

const router = Router();

router.get("/", getBudgets);
router.post("/", createBudget);
router.post("/copy", copyBudgets);
router.delete("/:id", deleteBudget);

export default router;
