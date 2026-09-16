import { Router } from "express";
import {
  getSummary,
  getEvolution,
  getDistribution,
} from "../controllers/dashboardController";

const router = Router();

router.get("/summary", getSummary);
router.get("/evolution", getEvolution);
router.get("/distribution", getDistribution);

export default router;
