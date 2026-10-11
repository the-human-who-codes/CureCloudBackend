import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../firebase.js";
import { getAccessiblePatient } from "../lib/access.js";
import { badRequest, parse, serialize } from "../lib/http.js";
import { PRIORITIES, STAFF_ROLES, id, isoDate, listQuery, name, shortText, vitals } from "../lib/schemas.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();
const patients = db.collection("patients");
const CLINICAL = ["doctor", "nurse"];

// GET /api/patients — staff see patients on their care team; admins see everyone.
router.get("/", requireRole(...CLINICAL, "admin"), async (req, res) => {
  const q = parse(listQuery, req.query);
  let query = patients;
  if (req.user.role !== "admin") query = query.where("careTeam", "array-contains", req.user.id);
  const snap = await query.orderBy("name").limit(q.limit).get();
  res.json({ patients: snap.docs.map(serialize) });
});

const createSchema = z.object({
  name,
  dateOfBirth: isoDate.optional(),
  room: shortText.optional(),
  priority: z.enum(PRIORITIES).default("stable"),
  nextMed: shortText.optional(),
});

// POST /api/patients — register a walk-in patient (no account needed). Creator joins the care team.
router.post("/", requireRole(...CLINICAL, "admin"), async (req, res) => {
  const body = parse(createSchema, req.body);
  const ref = await patients.add({
    userId: null,
    name: body.name,
    dateOfBirth: body.dateOfBirth ?? null,
    room: body.room ?? null,
    priority: body.priority,
    nextMed: body.nextMed ?? null,
    vitals: null,
    careTeam: req.user.role === "admin" ? [] : [req.user.id],
    createdAt: FieldValue.serverTimestamp(),
  });
  res.status(201).json({ patient: serialize(await ref.get()) });
});

// GET /api/patients/:id
router.get("/:id", requireRole(), async (req, res) => {
  res.json({ patient: await getAccessiblePatient(req.user, req.params.id) });
});

const updateSchema = z
  .object({
    room: shortText.nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    nextMed: shortText.nullable().optional(),
    careTeam: z.array(id).max(50).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

// PATCH /api/patients/:id — careTeam can only be set by admins.
router.patch("/:id", requireRole(...CLINICAL, "admin"), async (req, res) => {
  const body = parse(updateSchema, req.body);
  await getAccessiblePatient(req.user, req.params.id);

  if (body.careTeam) {
    if (req.user.role !== "admin") throw badRequest("Only admins can change the care team");
    const unique = [...new Set(body.careTeam)];
    const staff = unique.length
      ? await db.getAll(...unique.map((uid) => db.collection("users").doc(uid)))
      : [];
    const invalid = staff.filter((s) => !s.exists || !STAFF_ROLES.includes(s.data().role));
    if (invalid.length) {
      throw badRequest("careTeam must only contain doctor or nurse IDs", {
        invalid: invalid.map((s) => s.id),
      });
    }
    body.careTeam = unique;
  }

  const ref = patients.doc(req.params.id);
  await ref.update(body);
  res.json({ patient: serialize(await ref.get()) });
});

// POST /api/patients/:id/vitals — record a reading; also updates the patient's latest vitals.
router.post("/:id/vitals", requireRole(...CLINICAL), async (req, res) => {
  const reading = parse(vitals, req.body);
  const patient = await getAccessiblePatient(req.user, req.params.id);
  const ref = patients.doc(req.params.id);
  const readingRef = ref.collection("vitals").doc();
  const now = FieldValue.serverTimestamp();

  const batch = db.batch();
  batch.set(readingRef, { ...reading, recordedBy: req.user.id, recordedAt: now });
  batch.update(ref, { vitals: { ...(patient.vitals ?? {}), ...reading, recordedAt: now } });
  await batch.commit();

  res.status(201).json({ vitals: serialize(await readingRef.get()) });
});

// GET /api/patients/:id/vitals — history, newest first.
router.get("/:id/vitals", requireRole(), async (req, res) => {
  const q = parse(listQuery, req.query);
  await getAccessiblePatient(req.user, req.params.id);
  const snap = await patients
    .doc(req.params.id)
    .collection("vitals")
    .orderBy("recordedAt", "desc")
    .limit(q.limit)
    .get();
  res.json({ vitals: snap.docs.map(serialize) });
});

export default router;
