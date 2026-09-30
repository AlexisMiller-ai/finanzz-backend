import { Router } from "express";
import {
  getTransactions,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  deleteInstallmentGroup,
} from "../controllers/transactionsController";
import { importTransactions } from "../controllers/importController";
import { reconcileTransactions } from "../controllers/reconcileController";

const router = Router();

router.get("/", getTransactions);
router.post("/", createTransaction);
router.post("/import", importTransactions); // body.dry_run = true apenas analisa
router.post("/reconcile", reconcileTransactions); // marca lançamentos manuais como já conferidos
router.put("/:id", updateTransaction); // body.scope: single | future | all
router.delete("/group/:groupId", deleteInstallmentGroup);
router.delete("/:id", deleteTransaction); // ?scope=single | future | all

export default router;
