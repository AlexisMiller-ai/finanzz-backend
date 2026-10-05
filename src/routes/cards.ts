import { Router } from "express";
import {
  getCards,
  createCard,
  updateCard,
  deleteCard,
  adjustOutstanding,
} from "../controllers/cardsController";
import bills from "./bills";

const router = Router();

router.use("/:id/bills", bills); // faturas do cartão
router.get("/", getCards); // ?month=YYYY-MM para o total da fatura do mês
router.post("/", createCard);
router.put("/:id", updateCard);
router.put("/:id/outstanding", adjustOutstanding); // informa quanto deve hoje
router.delete("/:id", deleteCard);

export default router;
