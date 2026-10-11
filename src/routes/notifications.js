import { Router } from "express";
import { z } from "zod";
import { db } from "../firebase.js";
import { notFound, parse, serialize } from "../lib/http.js";
import { listQuery } from "../lib/schemas.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();
const notifications = db.collection("notifications");

router.use(requireRole());

// GET /api/notifications?unread=true
router.get("/", async (req, res) => {
  const q = parse(listQuery.extend({ unread: z.enum(["true", "false"]).optional() }), req.query);
  let query = notifications.where("userId", "==", req.user.id);
  if (q.unread === "true") query = query.where("read", "==", false);
  const snap = await query.orderBy("createdAt", "desc").limit(q.limit).get();
  res.json({ notifications: snap.docs.map(serialize) });
});

// POST /api/notifications/read-all
router.post("/read-all", async (req, res) => {
  const snap = await notifications
    .where("userId", "==", req.user.id)
    .where("read", "==", false)
    .limit(500) // batch write limit
    .get();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.update(d.ref, { read: true }));
  await batch.commit();
  res.json({ updated: snap.size });
});

// PATCH /api/notifications/:id/read
router.patch("/:id/read", async (req, res) => {
  const ref = notifications.doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists || snap.data().userId !== req.user.id) throw notFound("Notification");
  await ref.update({ read: true });
  res.json({ notification: serialize(await ref.get()) });
});

export default router;
