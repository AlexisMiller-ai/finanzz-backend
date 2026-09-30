import { Router } from "express";
import { createTransfer, deleteTransfer } from "../controllers/transfersController";

const router = Router();

router.post("/", createTransfer);
router.delete("/:transferId", deleteTransfer);

export default router;
