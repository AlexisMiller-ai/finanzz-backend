import { Router } from "express";
import { updateSavingsAdjustment } from "../controllers/savingsController";

const router = Router();

router.put("/", updateSavingsAdjustment);

export default router;
