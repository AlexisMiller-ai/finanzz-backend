import { Router } from "express";
import { getGoal, setGoal } from "../controllers/goalsController";

const router = Router();

router.get("/", getGoal);
router.post("/", setGoal);

export default router;
