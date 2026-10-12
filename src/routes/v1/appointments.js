// Appointments and practitioner busy times (docs/domain-model.md §2.7, §4.2 "Appointments").
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebase.js";
import {
  authorize,
  clinical,
  department,
  getDoc,
  patientsById,
  queries,
  redact,
  resolvePatientFilter,
  scoped,
  systemAdmin,
} from "../../authz/index.js";
import { writeAudit } from "../../lib/audit.js";
import { DAY, HOUR, MINUTE, addMs, isQuarterHour, mergeIntervals, sastParts, toDate, withinOpeningHours } from "../../lib/dates.js";
import { fetchAll, paginate } from "../../lib/firestore-query.js";
import { notify } from "../../lib/notify.js";
import { badRequest, conflict, fieldForbidden, forbidden, invalidTransition, notFound } from "../../lib/problem.js";
import { defineRoute } from "../../lib/route.js";
import { raw, toJson } from "../../lib/serialize.js";
import { getSettings } from "../../lib/settings.js";
import { createdFields, orNull, sendCreated, updatedFields } from "../../lib/write.js";
import {
  Appointment,
  AppointmentCreateRequest,
  AppointmentListQuery,
  AppointmentPage,
  AppointmentUpdateRequest,
  BusyQuery,
  BusyResponse,
  TERMINAL_APPOINTMENT_STATUSES,
  idParam,
} from "../../models/index.js";

const appointments = db.collection("appointments");
const UNIT = 15 * MINUTE;

// One lock per 15-minute unit: appointmentSlots/{doctorId}_{epochMillis}.
const slotRef = (doctorId, date) => db.collection("appointmentSlots").doc(`${doctorId}_${date.getTime()}`);
const units = (start, minutes) => Array.from({ length: Math.ceil(minutes / 15) }, (_, i) => addMs(start, i * UNIT));

const slotUnavailable = (detail) => conflict(detail, "slot-unavailable");
const describeWhen = (date) => {
  const { date: day, time } = sastParts(date);
  return `${day} at ${time}`;
};

async function loadDoctor(doctorId) {
  const doctor = await getDoc("users", doctorId);
  if (doctor?.role !== "doctor" || doctor.status !== "active") throw notFound("doctor");
  return doctor;
}

// Booking checks shared by create and reschedule (§2.7). Slot locks are checked in the transaction.
async function checkBookable(doctorId, start, durationMinutes, settings) {
  const { minLeadTimeMinutes, bookingWindowDays, openingHours } = settings.appointments;
  if (!isQuarterHour(start)) throw badRequest("start must be on a 15-minute boundary");
  const now = Date.now();
  if (start.getTime() < now + minLeadTimeMinutes * MINUTE) {
    throw badRequest(`Appointments must be booked at least ${minLeadTimeMinutes} minutes ahead`);
  }
  if (start.getTime() > now + bookingWindowDays * DAY) {
    throw badRequest(`Appointments can be booked at most ${bookingWindowDays} days ahead`);
  }
  const end = addMs(start, durationMinutes * MINUTE);
  if (!withinOpeningHours(start, end, openingHours)) throw slotUnavailable("That time is outside opening hours");
  const leave = await fetchAll(queries.staffShifts(doctorId, start, end));
  const onLeave = leave.some((s) => {
    const shift = s.data();
    return shift.type === "leave" && shift.status === "scheduled" && toDate(shift.end) > start && toDate(shift.start) < end;
  });
  if (onLeave) throw slotUnavailable("The doctor is on leave at that time");
  return end;
}

// Busy intervals for a doctor: booked slot locks merged with scheduled leave (no PHI).
async function busyIntervals(doctorId, from, to) {
  const [locks, shifts] = await Promise.all([
    fetchAll(queries.slotLocks(doctorId, from, to), { limit: 2000 }),
    fetchAll(queries.staffShifts(doctorId, from, to)),
  ]);
  const intervals = locks.map((l) => ({ start: toDate(l.get("start")), end: addMs(toDate(l.get("start")), UNIT) }));
  for (const s of shifts) {
    const shift = s.data();
    if (shift.type === "leave" && shift.status === "scheduled" && toDate(shift.end) > from) {
      intervals.push({ start: toDate(shift.start), end: toDate(shift.end) });
    }
  }
  return mergeIntervals(intervals).map((i) => ({ start: i.start.toISOString(), end: i.end.toISOString() }));
}

const appointmentResponse = (user, appt, patient) => redact(user, "appointment", toJson(appt), { patient });

// Transition table (§2.7): who may move the appointment to each status, and from where.
const TRANSITIONS = {
  confirmed: { from: ["pending"], roles: ["doctor", "admin"] },
  cancelled: { from: ["pending", "confirmed"], roles: ["patient", "doctor", "admin"] },
  "checked-in": { from: ["confirmed"], roles: ["nurse", "doctor", "admin"], notBefore: -2 * HOUR },
  completed: { from: ["confirmed", "checked-in"], roles: ["doctor"], notBefore: 0 },
  "no-show": { from: ["confirmed", "checked-in"], roles: ["doctor", "admin"], notBefore: 0 },
};

// Whether the caller acts on this appointment as its doctor, its patient, or another permitted role.
function mayAct(user, appt, patient) {
  if (user.role === "doctor") return appt.doctorId === user.id;
  if (user.role === "patient") return appt.patientUserId === user.id || patient?.userId === user.id;
  if (user.role === "nurse") return clinical(user, patient) || department(user, appt);
  return user.role === "admin";
}

export function register(router) {
  defineRoute(router, {
    method: "get",
    path: "/appointments",
    permission: "appointment:read",
    summary: "List appointments, sorted by start",
    description:
      "Default scope: patient (own), doctor (own schedule), nurse (own department, or a clinical patientId), admin (facility). doctorId accepts only me/own ID for doctors unless patientId is set; nurses need patientId for doctorId (400). Facility admins' doctorId lists stay pinned to their facility; admins cannot combine doctorId and departmentId (400).",
    tags: ["Appointments"],
    request: { query: AppointmentListQuery },
    responses: { 200: AppointmentPage },
    problems: ["404"],
    async handler(req, res) {
      const user = req.user;
      const { limit, cursor, patientId, from, to, ...filters } = req.valid.query;
      const patient = await resolvePatientFilter(user, patientId);
      const ctx = { patientId: patient?.id };
      if (user.role === "admin" && filters.doctorId && filters.doctorId !== "me") {
        const doctor = await getDoc("users", filters.doctorId);
        if (doctor?.role !== "doctor" || !(systemAdmin(user) || doctor.facilityId === user.facilityId)) {
          throw forbidden("doctorId must be a doctor in your facility");
        }
        ctx.doctorId = doctor.id;
      }
      if (user.role === "admin" && filters.departmentId) {
        const dept = await getDoc("departments", filters.departmentId);
        if (!dept || !(systemAdmin(user) || dept.facilityId === user.facilityId)) throw forbidden();
        ctx.departmentId = dept.id;
      }
      const s = scoped.appointments(user, { ...filters, from: from && new Date(from), to: to && new Date(to) }, ctx);
      const page = await paginate(s, { limit, cursor });
      const byId = patient ? new Map([[patient.id, patient]]) : await patientsById(page.docs.map((d) => d.get("patientId")));
      res.json({
        data: page.docs.map((d) => appointmentResponse(user, raw(d), byId.get(d.get("patientId")))),
        nextCursor: page.nextCursor,
      });
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/appointments",
    permission: "appointment:create",
    summary: "Book an appointment",
    description:
      "Patients book for themselves; staff pass patientId. Checks lead time and booking window (400), opening hours, the doctor's leave and the 15-minute slot locks (409 slot-unavailable). When staff book for a patient with a facility, the doctor must be in it (400; system admins excepted). Adds the doctor to the care team.",
    tags: ["Appointments"],
    request: { body: AppointmentCreateRequest },
    responses: { 201: Appointment },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      if (user.role !== "patient" && !body.patientId) throw badRequest("patientId is required");
      const patient = await resolvePatientFilter(user, body.patientId);
      if (!patient) throw notFound("patient");
      authorize(user, "appointment:create", {}, { patient }, { what: "patient" });
      if (patient.status !== "active") throw badRequest("The patient record is not active");

      const doctor = await loadDoctor(body.doctorId);
      if (!doctor.facilityId) throw badRequest("The doctor is not assigned to a facility yet");
      // Staff book within the patient's facility; a patient booking for themselves may choose any
      // active doctor (their own referral choice).
      if (user.role !== "patient" && !systemAdmin(user) && patient.facilityId && doctor.facilityId !== patient.facilityId) {
        throw badRequest("The doctor must be in the patient's facility");
      }

      const settings = await getSettings();
      const durationMinutes = body.durationMinutes ?? settings.appointments.defaultDurationMinutes;
      const start = new Date(body.start);
      const end = await checkBookable(doctor.id, start, durationMinutes, settings);

      const ref = appointments.doc();
      const patientRef = db.collection("patients").doc(patient.id);
      const locks = units(start, durationMinutes).map((u) => [slotRef(doctor.id, u), u]);
      await db.runTransaction(async (tx) => {
        const [fresh, ...lockSnaps] = await tx.getAll(patientRef, ...locks.map(([r]) => r));
        if (lockSnaps.some((s) => s.exists)) throw slotUnavailable("That time slot is already booked");
        const current = fresh.data();
        for (const [lockRef, unit] of locks) {
          tx.create(lockRef, { doctorId: doctor.id, start: Timestamp.fromDate(unit), appointmentId: ref.id });
        }
        tx.create(ref, {
          patientId: patient.id,
          patientName: current.name,
          patientUserId: current.userId ?? null,
          doctorId: doctor.id,
          doctorName: doctor.name,
          facilityId: doctor.facilityId,
          departmentId: doctor.departmentId ?? null,
          start: Timestamp.fromDate(start),
          end: Timestamp.fromDate(end),
          durationMinutes,
          type: body.type,
          reason: orNull(body.reason),
          status: "pending",
          cancellationReason: null,
          cancelledBy: null,
          checkedInAt: null,
          ...createdFields(user),
        });
        // The booked doctor needs clinical access to conduct the visit (§2.7).
        const patientUpdate = { ...updatedFields(user) };
        if (!current.careTeam?.includes(doctor.id)) {
          patientUpdate.careTeam = FieldValue.arrayUnion(doctor.id);
          writeAudit(tx, user, {
            action: "create",
            resource: { type: "care-team", id: doctor.id },
            patientId: patient.id,
            changedFields: ["careTeam"],
          });
        }
        if (!current.facilityId) patientUpdate.facilityId = doctor.facilityId;
        tx.update(patientRef, patientUpdate);
        writeAudit(tx, user, {
          action: "create",
          resource: { type: "appointment", id: ref.id },
          patientId: patient.id,
          changedFields: ["doctorId", "start", "durationMinutes", "type", ...(body.reason ? ["reason"] : [])],
        });
        const resource = { type: "appointment", id: ref.id };
        if (user.id !== doctor.id) {
          notify(tx, doctor.id, {
            title: "New appointment request",
            description: `${current.name} requested a ${body.type} on ${describeWhen(start)}`,
            type: "appointment",
            resource,
          });
        }
        if (user.role !== "patient") {
          notify(tx, current.userId, {
            title: "Appointment booked",
            description: `${body.type} with ${doctor.name} on ${describeWhen(start)}`,
            type: "appointment",
            resource,
          });
        }
      });
      const fresh = raw(await ref.get());
      sendCreated(res, `/appointments/${ref.id}`, appointmentResponse(user, fresh, await getDoc("patients", patient.id)));
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/appointments/{id}",
    permission: "appointment:read",
    summary: "Get an appointment",
    tags: ["Appointments"],
    request: { params: idParam },
    responses: { 200: Appointment },
    problems: ["404"],
    async handler(req, res) {
      const appt = await getDoc("appointments", req.valid.params.id);
      const patient = appt && (await getDoc("patients", appt.patientId));
      authorize(req.user, "appointment:read", appt, { patient });
      res.json(appointmentResponse(req.user, appt, patient));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/appointments/{id}",
    permission: "appointment:update",
    summary: "Change status, reschedule or edit an appointment",
    description:
      "Transitions per the lifecycle in §2.7. Patients may only send status: cancelled, cancellationReason, start and durationMinutes; a patient reschedule returns the appointment to pending. 409 invalid-state-transition when the change is not allowed from the current status.",
    tags: ["Appointments"],
    request: { params: idParam, body: AppointmentUpdateRequest },
    responses: { 200: Appointment },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const ref = appointments.doc(req.valid.params.id);
      const appt = raw(await ref.get());
      const patient = appt && (await getDoc("patients", appt.patientId));
      authorize(user, "appointment:update", appt, { patient });

      const allowedKeys = {
        patient: ["status", "cancellationReason", "start", "durationMinutes"],
        nurse: ["status"],
        doctor: ["status", "cancellationReason", "start", "durationMinutes", "type", "reason"],
        admin: ["status", "cancellationReason", "start", "durationMinutes", "type"],
      }[user.role];
      const denied = Object.keys(body).find((k) => !allowedKeys.includes(k));
      if (denied) throw fieldForbidden(denied);
      if (!mayAct(user, appt, patient)) throw forbidden("Only the appointment's doctor can change it");

      const reschedule = body.start !== undefined || body.durationMinutes !== undefined;
      if (reschedule && body.status === "cancelled") throw badRequest("Cancel or reschedule, not both");
      if (body.cancellationReason && body.status !== "cancelled") throw badRequest("cancellationReason needs status: cancelled");
      if (TERMINAL_APPOINTMENT_STATUSES.includes(appt.status)) throw invalidTransition(`The appointment is already ${appt.status}`);

      const update = { ...updatedFields(user) };
      const now = Date.now();
      const start = toDate(appt.start);
      if (body.status) {
        const rule = TRANSITIONS[body.status];
        if (!rule.roles.includes(user.role)) throw forbidden(`You cannot set an appointment to ${body.status}`);
        if (!rule.from.includes(appt.status)) throw invalidTransition(`Cannot change from ${appt.status} to ${body.status}`);
        if (rule.notBefore !== undefined && now < start.getTime() + rule.notBefore) {
          throw invalidTransition(`Too early to set ${body.status}`);
        }
        if (body.status === "cancelled" && user.role === "patient") {
          const { patientCancellationCutoffHours: cutoff } = (await getSettings()).appointments;
          if (now > start.getTime() - cutoff * HOUR) {
            throw invalidTransition(`Appointments can only be cancelled up to ${cutoff} hours before the start`);
          }
        }
        update.status = body.status;
        if (body.status === "cancelled") {
          update.cancellationReason = orNull(body.cancellationReason);
          update.cancelledBy = user.id;
        }
        if (body.status === "checked-in") update.checkedInAt = Timestamp.now();
      }
      if (body.type) update.type = body.type;
      if (body.reason !== undefined) update.reason = body.reason;

      let newStart = start;
      let newDuration = appt.durationMinutes;
      if (reschedule) {
        if (!["pending", "confirmed"].includes(appt.status)) throw invalidTransition("Only pending or confirmed appointments can be rescheduled");
        newStart = body.start ? new Date(body.start) : start;
        newDuration = body.durationMinutes ?? appt.durationMinutes;
        const end = await checkBookable(appt.doctorId, newStart, newDuration, await getSettings());
        Object.assign(update, {
          start: Timestamp.fromDate(newStart),
          end: Timestamp.fromDate(end),
          durationMinutes: newDuration,
        });
        if (user.role === "patient") update.status = "pending";
      }

      const oldUnits = new Map(units(start, appt.durationMinutes).map((u) => [u.getTime(), u]));
      const newUnits = new Map(units(newStart, newDuration).map((u) => [u.getTime(), u]));
      const releases = update.status === "cancelled" ? [...oldUnits.values()] : reschedule ? [...oldUnits.keys()].filter((k) => !newUnits.has(k)).map((k) => oldUnits.get(k)) : [];
      const acquires = reschedule ? [...newUnits.keys()].filter((k) => !oldUnits.has(k)).map((k) => newUnits.get(k)) : [];

      await db.runTransaction(async (tx) => {
        const [current, ...lockSnaps] = await tx.getAll(ref, ...acquires.map((u) => slotRef(appt.doctorId, u)));
        if (current.get("status") !== appt.status || current.get("updatedAt")?.toMillis?.() !== appt.updatedAt?.toMillis?.()) {
          throw conflict("The appointment changed while you were editing it; reload and try again");
        }
        if (lockSnaps.some((s) => s.exists)) throw slotUnavailable("That time slot is already booked");
        for (const u of releases) tx.delete(slotRef(appt.doctorId, u));
        for (const u of acquires) {
          tx.create(slotRef(appt.doctorId, u), { doctorId: appt.doctorId, start: Timestamp.fromDate(u), appointmentId: ref.id });
        }
        tx.update(ref, update);
        writeAudit(tx, user, {
          action: update.status ? "status-change" : "update",
          resource: { type: "appointment", id: ref.id },
          patientId: appt.patientId,
          changedFields: Object.keys(update).filter((k) => !["updatedAt", "updatedBy"].includes(k)),
        });
        const status = update.status ?? appt.status;
        const description = reschedule
          ? `${appt.type} moved to ${describeWhen(newStart)} (${status})`
          : `${appt.type} on ${describeWhen(start)} is now ${status}`;
        const message = {
          title: "Appointment updated",
          description,
          type: "appointment",
          priority: status === "cancelled" ? "important" : "normal",
          resource: { type: "appointment", id: ref.id },
        };
        if (user.role !== "doctor") notify(tx, appt.doctorId, message);
        if (user.role !== "patient") notify(tx, appt.patientUserId, message);
      });
      res.json(appointmentResponse(user, raw(await ref.get()), patient));
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/practitioners/{id}/busy",
    permission: "practitioner:read-busy",
    summary: "A doctor's busy intervals (bookings and leave), times only",
    description: "Window at most 31 days, default the next 7 days. Not paginated. Never says why a time is busy.",
    tags: ["Appointments"],
    request: { params: idParam, query: BusyQuery },
    responses: { 200: BusyResponse },
    problems: ["404"],
    async handler(req, res) {
      const doctor = await loadDoctor(req.valid.params.id);
      const from = req.valid.query.from ? new Date(req.valid.query.from) : new Date();
      const to = req.valid.query.to ? new Date(req.valid.query.to) : addMs(from, 7 * DAY);
      if (to <= from) throw badRequest("to must be after from");
      if (to - from > 31 * DAY) throw badRequest("The window can be at most 31 days");
      res.json({ data: await busyIntervals(doctor.id, from, to) });
    },
  });
}
