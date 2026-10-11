import { Router } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../firebase.js";
import { resolvePatientId } from "../lib/access.js";
import { toScheduledAt } from "../lib/dates.js";
import { badRequest, conflict, forbidden, notFound, parse, serialize } from "../lib/http.js";
import { notify } from "../lib/notify.js";
import { id, isoDate, listQuery, longText, shortText, time } from "../lib/schemas.js";
import { requireRole } from "../middleware/auth.js";

const router = Router();
const appointments = db.collection("appointments");
// One doc per doctor+time; transactional create() on it prevents double-booking.
const slotRef = (doctorId, scheduledAt) =>
  db.collection("appointmentSlots").doc(`${doctorId}_${scheduledAt.toMillis()}`);
const ACTIVE = ["pending", "confirmed"];

function futureSlot(date, t) {
  const scheduledAt = toScheduledAt(date, t);
  if (!scheduledAt) throw badRequest("Invalid date/time");
  if (scheduledAt.toMillis() <= Date.now()) throw badRequest("Appointment must be in the future");
  return scheduledAt;
}

const listSchema = listQuery.extend({
  patientId: id.optional(),
  upcoming: z.enum(["true", "false"]).optional(),
});

// GET /api/appointments — patients: their own; doctors: their schedule (or ?patientId=);
// nurses: ?patientId= required; admins: everything.
router.get("/", requireRole(), async (req, res) => {
  const q = parse(listSchema, req.query);
  const { role } = req.user;
  let query = appointments;

  if (role === "patient" || q.patientId) {
    query = query.where("patientId", "==", await resolvePatientId(req.user, q.patientId));
  } else if (role === "doctor") {
    query = query.where("doctorId", "==", req.user.id);
  } else if (role !== "admin") {
    throw badRequest("patientId is required");
  }
  if (q.upcoming === "true") query = query.where("scheduledAt", ">=", Timestamp.now());

  const snap = await query.orderBy("scheduledAt").limit(q.limit).get();
  res.json({ appointments: snap.docs.map(serialize) });
});

const createSchema = z.object({
  doctorId: id,
  patientId: id.optional(),
  date: isoDate,
  time,
  type: shortText.default("General Checkup"),
  notes: longText.optional(),
});

// POST /api/appointments — patients book for themselves; staff book for a patient they can access.
router.post("/", requireRole(), async (req, res) => {
  const body = parse(createSchema, req.body);
  const patientId = await resolvePatientId(req.user, body.patientId);
  const scheduledAt = futureSlot(body.date, body.time);

  const doctorSnap = await db.collection("users").doc(body.doctorId).get();
  const doctor = doctorSnap.data();
  if (!doctorSnap.exists || doctor.role !== "doctor" || doctor.status !== "active") {
    throw notFound("Doctor");
  }

  const ref = appointments.doc();
  const patientRef = db.collection("patients").doc(patientId);
  const slot = slotRef(body.doctorId, scheduledAt);

  await db.runTransaction(async (tx) => {
    const [patientSnap, slotSnap] = await Promise.all([tx.get(patientRef), tx.get(slot)]);
    if (!patientSnap.exists) throw notFound("Patient");
    if (slotSnap.exists) throw conflict("That time slot is already booked");
    const patient = patientSnap.data();
    const now = FieldValue.serverTimestamp();

    tx.create(slot, { appointmentId: ref.id });
    tx.create(ref, {
      patientId,
      patientUserId: patient.userId ?? null,
      patientName: patient.name,
      doctorId: body.doctorId,
      doctorName: doctor.name,
      date: body.date,
      time: body.time,
      scheduledAt,
      type: body.type,
      notes: body.notes ?? null,
      status: "pending",
      createdBy: req.user.id,
      createdAt: now,
      updatedAt: now,
    });
    // Booking gives the doctor access to the patient's records.
    tx.update(patientRef, { careTeam: FieldValue.arrayUnion(body.doctorId) });

    const when = `${body.date} at ${body.time}`;
    notify(tx, body.doctorId, {
      title: "New appointment request",
      description: `${patient.name} requested a ${body.type} on ${when}`,
      type: "appointment",
    });
    if (req.user.role !== "patient") {
      notify(tx, patient.userId, {
        title: "Appointment booked",
        description: `${body.type} with ${doctor.name} on ${when}`,
        type: "appointment",
      });
    }
  });

  res.status(201).json({ appointment: serialize(await ref.get()) });
});

const updateSchema = z
  .object({
    status: z.enum(["confirmed", "completed", "cancelled"]).optional(),
    date: isoDate.optional(),
    time: time.optional(),
    type: shortText.optional(),
    notes: longText.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .refine((v) => (v.date === undefined) === (v.time === undefined), {
    message: "date and time must be provided together",
  });

// PATCH /api/appointments/:id — status changes and rescheduling.
// Patients may only cancel or reschedule their own; doctors manage their own; admins anything.
router.patch("/:id", requireRole("patient", "doctor", "admin"), async (req, res) => {
  const body = parse(updateSchema, req.body);
  const { role, id: uid } = req.user;
  if (role === "patient") {
    if (body.status && body.status !== "cancelled") throw forbidden("Patients can only cancel");
    if (body.notes !== undefined || body.type) throw forbidden("Patients cannot edit notes or type");
  }
  const newSlot = body.date ? futureSlot(body.date, body.time) : null;
  const ref = appointments.doc(req.params.id);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Appointment");
    const appt = snap.data();
    const owns =
      role === "admin" ||
      (role === "doctor" && appt.doctorId === uid) ||
      (role === "patient" && appt.patientId === uid);
    if (!owns) throw notFound("Appointment");
    if (!ACTIVE.includes(appt.status)) throw conflict(`Appointment is already ${appt.status}`);

    const rescheduled = newSlot && newSlot.toMillis() !== appt.scheduledAt.toMillis();
    const newSlotRef = rescheduled ? slotRef(appt.doctorId, newSlot) : null;
    if (newSlotRef && (await tx.get(newSlotRef)).exists) {
      throw conflict("That time slot is already booked");
    }

    const update = { ...body, updatedAt: FieldValue.serverTimestamp() };
    delete update.date;
    delete update.time;
    if (rescheduled) {
      Object.assign(update, { date: body.date, time: body.time, scheduledAt: newSlot });
      // A reschedule needs re-confirmation unless a doctor/admin set the status explicitly.
      if (!body.status) update.status = "pending";
    }

    const releasesSlot = rescheduled || update.status === "cancelled";
    if (releasesSlot) tx.delete(slotRef(appt.doctorId, appt.scheduledAt));
    if (newSlotRef && update.status !== "cancelled") {
      tx.create(newSlotRef, { appointmentId: ref.id });
    }
    tx.update(ref, update);

    const status = update.status ?? appt.status;
    const when = `${update.date ?? appt.date} at ${update.time ?? appt.time}`;
    const description = rescheduled
      ? `${appt.type} moved to ${when} (${status})`
      : `${appt.type} on ${when} is now ${status}`;
    if (role === "patient") {
      notify(tx, appt.doctorId, { title: "Appointment updated", description, type: "appointment" });
    } else {
      notify(tx, appt.patientUserId, {
        title: "Appointment updated",
        description,
        type: "appointment",
        priority: status === "cancelled" ? "important" : "normal",
      });
    }
  });

  res.json({ appointment: serialize(await ref.get()) });
});

export default router;
