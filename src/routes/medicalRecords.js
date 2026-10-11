import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../firebase.js";
import { getAccessiblePatient, resolvePatientId } from "../lib/access.js";
import { badRequest, conflict, notFound, parse, serialize } from "../lib/http.js";
import { notify } from "../lib/notify.js";
import { id, listQuery, longText, shortText } from "../lib/schemas.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();
const records = db.collection("medicalRecords");
const STATUSES = ["preliminary", "final"];

const listSchema = listQuery.extend({ patientId: id.optional() });

// GET /api/medical-records?patientId= — doctors without patientId get records they authored.
router.get("/", requireRole(), async (req, res) => {
  const q = parse(listSchema, req.query);
  let query = records;
  if (req.user.role === "doctor" && !q.patientId) {
    query = query.where("doctorId", "==", req.user.id);
  } else {
    query = query.where("patientId", "==", await resolvePatientId(req.user, q.patientId));
  }
  const snap = await query.orderBy("createdAt", "desc").limit(q.limit).get();
  res.json({ medicalRecords: snap.docs.map(serialize) });
});

const content = {
  diagnosis: longText.optional(),
  treatment: longText.optional(),
  results: longText.optional(),
  recommendations: longText.optional(),
};

const createSchema = z
  .object({
    patientId: id,
    type: shortText, // e.g. "Consultation", "Blood Work", "X-Ray"
    ...content,
    appointmentId: id.optional(),
    status: z.enum(STATUSES).default("final"),
  })
  .refine((v) => v.diagnosis || v.results, "Either diagnosis or results is required");

// POST /api/medical-records — doctors only.
router.post("/", requireRole("doctor"), async (req, res) => {
  const body = parse(createSchema, req.body);
  const patient = await getAccessiblePatient(req.user, body.patientId);

  if (body.appointmentId) {
    const appt = await db.collection("appointments").doc(body.appointmentId).get();
    if (!appt.exists || appt.data().patientId !== body.patientId) {
      throw badRequest("appointmentId does not belong to this patient");
    }
  }

  const ref = records.doc();
  const batch = db.batch();
  batch.create(ref, {
    patientId: body.patientId,
    patientName: patient.name,
    doctorId: req.user.id,
    doctorName: req.user.name,
    type: body.type,
    diagnosis: body.diagnosis ?? null,
    treatment: body.treatment ?? null,
    results: body.results ?? null,
    recommendations: body.recommendations ?? null,
    appointmentId: body.appointmentId ?? null,
    status: body.status,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (body.status === "final") {
    notify(batch, patient.userId, {
      title: "New medical record",
      description: `${body.type} added by ${req.user.name}`,
      type: "record",
    });
  }
  await batch.commit();
  res.status(201).json({ medicalRecord: serialize(await ref.get()) });
});

const updateSchema = z
  .object({ ...content, status: z.enum(STATUSES).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

// PATCH /api/medical-records/:id — author only, and only while preliminary. Final records are immutable.
router.patch("/:id", requireRole("doctor"), async (req, res) => {
  const body = parse(updateSchema, req.body);
  const ref = records.doc(req.params.id);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().doctorId !== req.user.id) throw notFound("Medical record");
    const record = snap.data();
    if (record.status === "final") throw conflict("Final records cannot be edited");
    // Transactions require all reads before any writes.
    const patient = body.status === "final" ? await tx.get(db.collection("patients").doc(record.patientId)) : null;
    tx.update(ref, { ...body, updatedAt: FieldValue.serverTimestamp() });
    if (patient) {
      notify(tx, patient.data()?.userId, {
        title: "Medical record finalised",
        description: `${record.type} by ${req.user.name}`,
        type: "record",
      });
    }
  });

  res.json({ medicalRecord: serialize(await ref.get()) });
});

export default router;
