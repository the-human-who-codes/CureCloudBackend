import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../firebase.js";
import { badRequest, conflict, notFound, parse, serialize } from "../lib/http.js";
import { isoDate, name, phone } from "../lib/schemas.js";
import { publicUser } from "../lib/users.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();

const isBootstrapAdmin = ({ email, emailVerified }) => {
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  return Boolean(adminEmail && emailVerified && email?.toLowerCase() === adminEmail);
};

// GET /api/me — 404 means the user is signed in but has no profile yet (send them to onboarding).
router.get("/", async (req, res) => {
  if (!req.user) throw notFound("Profile");
  const body = { user: publicUser(req.user, { includePrivate: true }) };
  if (req.user.role === "patient") {
    const snap = await db.collection("patients").doc(req.user.id).get();
    body.patient = snap.exists ? serialize(snap) : null;
  }
  res.json(body);
});

const createSchema = z.object({
  name: name.optional(),
  phoneNumber: phone.optional(),
  dateOfBirth: isoDate.optional(),
});

// POST /api/me — first-time profile creation after Google sign-in. Creates a patient,
// or an admin if the caller's verified email matches BOOTSTRAP_ADMIN_EMAIL.
router.post("/", async (req, res) => {
  if (req.user) throw conflict("Profile already exists");
  const body = parse(createSchema, req.body);
  const displayName = body.name ?? req.auth.name;
  if (!displayName) throw badRequest("name is required");

  const role = isBootstrapAdmin(req.auth) ? "admin" : "patient";
  const uid = req.auth.uid;
  const now = FieldValue.serverTimestamp();
  const batch = db.batch();

  batch.create(db.collection("users").doc(uid), {
    name: displayName,
    email: req.auth.email,
    role,
    status: "active",
    phoneNumber: body.phoneNumber ?? null,
    facilityId: null,
    createdAt: now,
  });
  if (role === "patient") {
    batch.create(db.collection("patients").doc(uid), {
      userId: uid,
      name: displayName,
      dateOfBirth: body.dateOfBirth ?? null,
      room: null,
      priority: "stable",
      nextMed: null,
      vitals: null,
      careTeam: [],
      createdAt: now,
    });
  }

  try {
    await batch.commit();
  } catch (err) {
    if (err.code === 6) throw conflict("Profile already exists"); // ALREADY_EXISTS race
    throw err;
  }

  const user = serialize(await db.collection("users").doc(uid).get());
  res.status(201).json({ user: publicUser(user, { includePrivate: true }) });
});

const updateSchema = z
  .object({ name: name.optional(), phoneNumber: phone.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

// PATCH /api/me
router.patch("/", requireRole(), async (req, res) => {
  const body = parse(updateSchema, req.body);
  const batch = db.batch();
  batch.update(db.collection("users").doc(req.user.id), body);
  if (body.name && req.user.role === "patient") {
    batch.update(db.collection("patients").doc(req.user.id), { name: body.name });
  }
  await batch.commit();
  const user = serialize(await db.collection("users").doc(req.user.id).get());
  res.json({ user: publicUser(user, { includePrivate: true }) });
});

export default router;
