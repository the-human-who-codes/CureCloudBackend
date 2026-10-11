import { Router } from "express";
import { z } from "zod";
import { auth, db } from "../firebase.js";
import { badRequest, notFound, parse, serialize } from "../lib/http.js";
import { ROLES, STAFF_ROLES, USER_STATUSES, listQuery, shortText } from "../lib/schemas.js";
import { publicUser } from "../lib/users.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

// GET /api/doctors — directory for booking. Mounted separately; any active user.
export const doctorsRouter = Router().get("/", requireRole(), async (_req, res) => {
  const snap = await db
    .collection("users")
    .where("role", "==", "doctor")
    .where("status", "==", "active")
    .get();
  const doctors = snap.docs
    .map((d) => {
      const { name, specialization = null, facilityId = null } = d.data();
      return { id: d.id, name, specialization, facilityId };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ doctors });
});

router.use(requireRole("admin"));

const listSchema = listQuery.extend({
  role: z.enum(ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
});

// GET /api/users?role=&status= — admin user management.
router.get("/", async (req, res) => {
  const q = parse(listSchema, req.query);
  let query = db.collection("users");
  if (q.role) query = query.where("role", "==", q.role);
  if (q.status) query = query.where("status", "==", q.status);
  const snap = await query.limit(q.limit).get();
  const users = snap.docs
    .map((d) => publicUser(serialize(d), { includePrivate: true }))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  res.json({ users });
});

const updateSchema = z
  .object({
    role: z.enum([...STAFF_ROLES, "admin"]).optional(),
    status: z.enum(USER_STATUSES).optional(),
    facilityId: z.string().trim().max(128).nullable().optional(),
    specialization: shortText.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

// PATCH /api/users/:id — approve staff, change role, disable accounts.
router.patch("/:id", async (req, res) => {
  const body = parse(updateSchema, req.body);
  const ref = db.collection("users").doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("User");
  const target = snap.data();

  if (req.params.id === req.user.id && (body.role || body.status)) {
    throw badRequest("You cannot change your own role or status");
  }
  if (body.role && target.role === "patient") {
    throw badRequest("Patient accounts cannot be converted to staff accounts");
  }

  await ref.update(body);
  if (body.status && body.status !== target.status) {
    await auth.updateUser(req.params.id, { disabled: body.status === "disabled" });
  }
  res.json({ user: publicUser(serialize(await ref.get()), { includePrivate: true }) });
});

export default router;
