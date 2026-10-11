import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../firebase.js";
import { getAccessiblePatient, resolvePatientId } from "../lib/access.js";
import { badRequest, notFound, parse, serialize } from "../lib/http.js";
import { notify } from "../lib/notify.js";
import { PRESCRIPTION_STATUSES, id, isoDate, listQuery, longText, shortText } from "../lib/schemas.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();
const prescriptions = db.collection("prescriptions");

const listSchema = listQuery.extend({
  patientId: id.optional(),
  status: z.enum(PRESCRIPTION_STATUSES).optional(),
});

// GET /api/prescriptions?patientId=&status= — doctors without patientId get the ones they wrote.
router.get("/", requireRole(), async (req, res) => {
  const q = parse(listSchema, req.query);
  let query = prescriptions;
  if (req.user.role === "doctor" && !q.patientId) {
    query = query.where("doctorId", "==", req.user.id);
  } else {
    query = query.where("patientId", "==", await resolvePatientId(req.user, q.patientId));
  }
  if (q.status) query = query.where("status", "==", q.status);
  const snap = await query.orderBy("createdAt", "desc").limit(q.limit).get();
  res.json({ prescriptions: snap.docs.map(serialize) });
});

const createSchema = z
  .object({
    patientId: id,
    medication: shortText,
    dosage: shortText,
    frequency: shortText,
    startDate: isoDate,
    endDate: isoDate.optional(),
    refills: z.number().int().min(0).max(12).default(0),
    notes: longText.optional(),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, {
    message: "endDate must be on or after startDate",
    path: ["endDate"],
  });

// POST /api/prescriptions — doctors only.
router.post("/", requireRole("doctor"), async (req, res) => {
  const body = parse(createSchema, req.body);
  const patient = await getAccessiblePatient(req.user, body.patientId);
  const ref = prescriptions.doc();
  const batch = db.batch();
  batch.create(ref, {
    ...body,
    endDate: body.endDate ?? null,
    notes: body.notes ?? null,
    patientName: patient.name,
    doctorId: req.user.id,
    doctorName: req.user.name,
    status: "active",
    createdAt: FieldValue.serverTimestamp(),
  });
  notify(batch, patient.userId, {
    title: "New prescription",
    description: `${body.medication} ${body.dosage}, ${body.frequency}`,
    type: "prescription",
  });
  await batch.commit();
  res.status(201).json({ prescription: serialize(await ref.get()) });
});

const updateSchema = z
  .object({
    status: z.enum(PRESCRIPTION_STATUSES).optional(),
    refills: z.number().int().min(0).max(12).optional(),
    endDate: isoDate.nullable().optional(),
    notes: longText.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

// PATCH /api/prescriptions/:id — prescribing doctor or admin.
router.patch("/:id", requireRole("doctor", "admin"), async (req, res) => {
  const body = parse(updateSchema, req.body);
  const ref = prescriptions.doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Prescription");
  const rx = snap.data();
  if (req.user.role === "doctor" && rx.doctorId !== req.user.id) throw notFound("Prescription");
  if (body.endDate && body.endDate < rx.startDate) {
    throw badRequest("endDate must be on or after startDate");
  }
  await ref.update({ ...body, updatedAt: FieldValue.serverTimestamp() });
  res.json({ prescription: serialize(await ref.get()) });
});

export default router;
