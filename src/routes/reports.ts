import { Router } from "express";
import { getReport } from "../controllers/reportsController";

const router = Router();

router.get("/", getReport); // ?from=YYYY-MM-DD&to=YYYY-MM-DD

export default router;
