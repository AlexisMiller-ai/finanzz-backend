import { Router } from "express";
import {
  getAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  adjustBalance,
} from "../controllers/accountsController";

const router = Router();

router.get("/", getAccounts);
router.post("/", createAccount);
router.put("/:id", updateAccount);
router.put("/:id/balance", adjustBalance); // informa o saldo atual e ajusta o inicial
router.delete("/:id", deleteAccount);

export default router;
