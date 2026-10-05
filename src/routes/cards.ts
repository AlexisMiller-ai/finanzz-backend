import { Router } from "express";
import { getCards, createCard, updateCard, deleteCard } from "../controllers/cardsController";

const router = Router();

router.get("/", getCards); // ?month=YYYY-MM para o total da fatura do mês
router.post("/", createCard);
router.put("/:id", updateCard);
router.delete("/:id", deleteCard);

export default router;
