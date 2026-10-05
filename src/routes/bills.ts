import { Router } from "express";
import { getBills, payBill, settlePastBills, unpayBill } from "../controllers/billsController";

// Montado em /cards/:id/bills — faturas de um cartão.
const router = Router({ mergeParams: true });

router.get("/", getBills);
router.post("/settle-past", settlePastBills); // baixa em tudo que já fechou
router.post("/:month/pay", payBill); // :month = YYYY-MM
router.delete("/:month/pay", unpayBill);

export default router;
