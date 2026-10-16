import { Router } from "express";
import {
  register,
  login,
  me,
  updateProfile,
  changePassword,
  updateAvatar,
  removeAvatar,
} from "../controllers/authController";
import { authenticate } from "../middleware/auth";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.get("/me", authenticate, me);
router.put("/me", authenticate, updateProfile);
router.put("/password", authenticate, changePassword);
router.put("/avatar", authenticate, updateAvatar);
router.delete("/avatar", authenticate, removeAvatar);

export default router;
