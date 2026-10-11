import { Router } from "express";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

const count = async (query) => (await query.count().get()).data().count;

// GET /api/admin/stats — dashboard counters (aggregation queries: 1 read per 1000 docs counted).
router.get("/stats", requireRole("admin"), async (_req, res) => {
  const users = db.collection("users");
  const [totalDoctors, totalNurses, totalPatients, pendingStaff, activeAppointments] =
    await Promise.all([
      count(users.where("role", "==", "doctor").where("status", "==", "active")),
      count(users.where("role", "==", "nurse").where("status", "==", "active")),
      count(db.collection("patients")),
      count(users.where("status", "==", "pending")),
      count(
        db
          .collection("appointments")
          .where("status", "in", ["pending", "confirmed"])
          .where("scheduledAt", ">=", Timestamp.now()),
      ),
    ]);
  res.json({ totalDoctors, totalNurses, totalPatients, pendingStaff, activeAppointments });
});

export default router;
