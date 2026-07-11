import { Router } from "express";
import {
  getSummary,
  getDistribution,
} from "../controllers/dashboardController";

const router = Router();

router.get("/summary", getSummary);
router.get("/distribution", getDistribution);

export default router;
