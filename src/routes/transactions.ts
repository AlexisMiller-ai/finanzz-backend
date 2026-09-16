import { Router } from "express";
import {
  getTransactions,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  deleteInstallmentGroup,
} from "../controllers/transactionsController";

const router = Router();

router.get("/", getTransactions);
router.post("/", createTransaction);
router.put("/:id", updateTransaction); // body.scope: single | future | all
router.delete("/group/:groupId", deleteInstallmentGroup);
router.delete("/:id", deleteTransaction); // ?scope=single | future | all

export default router;
