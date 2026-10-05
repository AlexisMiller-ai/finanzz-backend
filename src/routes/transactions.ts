import { Router } from "express";
import {
  getTransactions,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  deleteInstallmentGroup,
  moveTransactions,
  settleTransaction,
} from "../controllers/transactionsController";
import { getUpcoming } from "../controllers/upcomingController";
import { importTransactions } from "../controllers/importController";
import { reconcileTransactions } from "../controllers/reconcileController";

const router = Router();

router.get("/", getTransactions); // ?month=&status=pendente|efetivado
router.get("/upcoming", getUpcoming); // contas a pagar e a receber (?days=7)
router.post("/", createTransaction);
router.post("/import", importTransactions); // body.dry_run = true apenas analisa
router.post("/reconcile", reconcileTransactions); // marca lançamentos manuais como já conferidos
router.post("/move", moveTransactions); // move em lote para outra conta/cartão
router.put("/:id/settle", settleTransaction); // body.settled = false volta a pendente
router.put("/:id", updateTransaction); // body.scope: single | future | all
router.delete("/group/:groupId", deleteInstallmentGroup);
router.delete("/:id", deleteTransaction); // ?scope=single | future | all

export default router;
