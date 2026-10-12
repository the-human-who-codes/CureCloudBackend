// Prescriptions, refill requests, the medication schedule and administrations
// (docs/domain-model.md §2.8, §2.9, §4.2 "Prescriptions and medication administration").
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebase.js";
import {
  authorize,
  getDoc,
  loadPatient,
  queries,
  redact,
  resolvePatientFilter,
  scoped,
  visibleDocs,
} from "../../authz/index.js";
import { writeAudit } from "../../lib/audit.js";
import { DAY, MINUTE, isoWeekday, sastDate, sastInstant, sastParts } from "../../lib/dates.js";
import { count, fetchAll, paginate } from "../../lib/firestore-query.js";
import { notify } from "../../lib/notify.js";
import { badRequest, conflict, fieldForbidden, forbidden, invalidTransition } from "../../lib/problem.js";
import { defineRoute } from "../../lib/route.js";
import { raw, serialize, toJson } from "../../lib/serialize.js";
import { createdFields, orNull, sendCreated, updatedFields } from "../../lib/write.js";
import {
  AdministrationCreateRequest,
  AdministrationListQuery,
  AdministrationRetractRequest,
  FREQUENCY_TIMES,
  MedicationAdministration,
  MedicationAdministrationPage,
  MedicationSchedule,
  MedicationScheduleQuery,
  PRESCRIPTION_TRANSITIONS,
  Prescription,
  PrescriptionCreateRequest,
  PrescriptionListQuery,
  PrescriptionPage,
  PrescriptionUpdateRequest,
  RefillRequest,
  RefillResponse,
  idParam,
} from "../../models/index.js";

const prescriptions = db.collection("prescriptions");
const administrations = db.collection("medicationAdministrations");
const DUE_WINDOW = 30 * MINUTE;

const isCurrent = (rx, date = sastDate()) =>
  rx.status === "active" && rx.startDate <= date && (!rx.endDate || date <= rx.endDate);

// Scheduled dose times for one SAST date, honouring once (start date only) and weekly (same weekday).
function dosesOn(rx, date) {
  if (rx.frequency === "as-needed" || !isCurrent(rx, date)) return [];
  if (rx.frequency === "once" && date !== rx.startDate) return [];
  if (rx.frequency === "weekly" && isoWeekday(date) !== isoWeekday(rx.startDate)) return [];
  return rx.administrationTimes.map((t) => sastInstant(date, t));
}

// A scheduled dose has at most one live administration (§1.1, §2.9): it is locked by
// administrationSlots/{prescriptionId}_{epochMillis}, released when the administration is retracted.
const slotRef = (prescriptionId, scheduledFor) =>
  db.collection("administrationSlots").doc(`${prescriptionId}_${scheduledFor.getTime()}`);

async function loadPrescription(user, id, permission = "prescription:read") {
  const rx = await getDoc("prescriptions", id);
  const patient = rx && (await getDoc("patients", rx.patientId));
  authorize(user, permission, rx, { patient });
  return { rx, patient };
}

function checkTimes(frequency, times) {
  if (frequency === "once" && times.length !== 1) throw badRequest("once requires exactly one administration time");
  if (frequency === "as-needed" && times.length) throw badRequest("as-needed prescriptions have no scheduled times");
  if (frequency === "custom" && !times.length) throw badRequest("custom requires at least one administration time");
}

export function register(router) {
  defineRoute(router, {
    method: "get",
    path: "/prescriptions",
    permission: "prescription:read",
    summary: "List prescriptions, newest first",
    description:
      "Patients: their own. Doctors without patientId: prescriberId defaults to and must be me, and only prescriptions for patients still clinical to the caller are returned (the page may hold fewer than limit items). Nurses must pass a clinical patientId (400 without one). Excludes entered-in-error unless asked for.",
    tags: ["Prescriptions"],
    request: { query: PrescriptionListQuery },
    responses: { 200: PrescriptionPage },
    problems: ["404"],
    async handler(req, res) {
      const { limit, cursor, patientId, ...filters } = req.valid.query;
      const patient = await resolvePatientFilter(req.user, patientId, "prescription:read");
      const page = await paginate(scoped.prescriptions(req.user, filters, { patientId: patient?.id }), { limit, cursor });
      const visible = await visibleDocs(req.user, "prescription:read", page.docs, patient);
      res.json({ data: visible.map((d) => redact(req.user, "prescription", serialize(d))), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/prescriptions",
    permission: "prescription:create",
    summary: "Prescribe a medication",
    description: "category defaults to inpatient when the patient is admitted. administrationTimes default from frequency.",
    tags: ["Prescriptions"],
    request: { body: PrescriptionCreateRequest },
    responses: { 201: Prescription },
    problems: ["404"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const patient = await loadPatient(user, body.patientId);
      authorize(user, "prescription:create", {}, { patient });
      if (body.appointmentId) {
        const appt = await getDoc("appointments", body.appointmentId);
        if (appt?.patientId !== patient.id) throw badRequest("appointmentId does not belong to this patient");
      }
      const administrationTimes = body.administrationTimes ?? FREQUENCY_TIMES[body.frequency] ?? [];
      checkTimes(body.frequency, administrationTimes);
      const ref = prescriptions.doc();
      const batch = db.batch();
      batch.create(ref, {
        patientId: patient.id,
        patientName: patient.name,
        facilityId: patient.facilityId ?? null,
        prescriberId: user.id,
        prescriberName: user.name,
        category: body.category ?? (patient.admission ? "inpatient" : "outpatient"),
        medication: body.medication,
        dose: body.dose,
        route: body.route,
        frequency: body.frequency,
        frequencyText: orNull(body.frequencyText),
        administrationTimes,
        instructions: orNull(body.instructions),
        refills: body.refills,
        startDate: body.startDate,
        endDate: orNull(body.endDate),
        status: "active",
        statusReason: null,
        appointmentId: orNull(body.appointmentId),
        ...createdFields(user),
      });
      writeAudit(batch, user, {
        action: "create",
        resource: { type: "prescription", id: ref.id },
        patientId: patient.id,
        changedFields: Object.keys(body),
      });
      notify(batch, patient.userId, {
        title: "New prescription",
        description: `${body.medication} ${body.dose} prescribed by ${user.name}`,
        type: "prescription",
        resource: { type: "prescription", id: ref.id },
      });
      await batch.commit();
      sendCreated(res, `/prescriptions/${ref.id}`, redact(user, "prescription", serialize(await ref.get())));
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/prescriptions/{id}",
    permission: "prescription:read",
    summary: "Get a prescription",
    tags: ["Prescriptions"],
    request: { params: idParam },
    responses: { 200: Prescription },
    problems: ["404"],
    async handler(req, res) {
      const { rx } = await loadPrescription(req.user, req.valid.params.id);
      res.json(redact(req.user, "prescription", toJson(rx)));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/prescriptions/{id}",
    permission: "prescription:update",
    summary: "Hold, resume, stop or edit a prescription",
    description:
      "The prescriber or a doctor with clinical access may hold, resume or stop. Only the prescriber edits endDate, refills, instructions and administrationTimes (while active or on-hold), completes, or sets entered-in-error (only if no dose was given).",
    tags: ["Prescriptions"],
    request: { params: idParam, body: PrescriptionUpdateRequest },
    responses: { 200: Prescription },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const { rx } = await loadPrescription(user, req.valid.params.id, "prescription:update");
      const isPrescriber = rx.prescriberId === user.id;
      const edits = ["endDate", "refills", "instructions", "administrationTimes"].filter((k) => body[k] !== undefined);
      if (edits.length && !isPrescriber) throw fieldForbidden(edits[0]);
      if (body.statusReason && !body.status) throw badRequest("statusReason needs a status");

      if (body.status && body.status !== rx.status) {
        if (!(PRESCRIPTION_TRANSITIONS[rx.status] ?? []).includes(body.status)) {
          throw invalidTransition(`Cannot change from ${rx.status} to ${body.status}`);
        }
        if (["completed", "entered-in-error"].includes(body.status) && !isPrescriber) {
          throw forbidden(`Only the prescriber can set ${body.status}`);
        }
        if (["on-hold", "stopped", "entered-in-error"].includes(body.status) && !body.statusReason) {
          throw badRequest(`statusReason is required for ${body.status}`);
        }
        if (body.status === "entered-in-error" && (await count(queries.completedAdministrations(rx.id))) > 0) {
          throw invalidTransition("Doses were already given; stop the prescription instead");
        }
      }
      if (edits.length && !["active", "on-hold"].includes(rx.status)) {
        throw conflict(`A ${rx.status} prescription cannot be edited`, "record-immutable");
      }
      const endDate = body.endDate === undefined ? rx.endDate : body.endDate;
      if (endDate && endDate < rx.startDate) throw badRequest("endDate must be on or after startDate");
      if (body.administrationTimes) checkTimes(rx.frequency, body.administrationTimes);

      const update = { ...body, ...updatedFields(user) };
      const ref = prescriptions.doc(rx.id);
      const batch = db.batch();
      batch.update(ref, update);
      writeAudit(batch, user, {
        action: body.status ? "status-change" : "update",
        resource: { type: "prescription", id: rx.id },
        patientId: rx.patientId,
        changedFields: Object.keys(body),
      });
      if (body.status === "stopped") {
        const patient = await getDoc("patients", rx.patientId);
        notify(batch, patient?.userId, {
          title: "Prescription stopped",
          description: `${rx.medication} ${rx.dose} was stopped by ${user.name}`,
          type: "prescription",
          resource: { type: "prescription", id: rx.id },
        });
      }
      await batch.commit();
      res.json(redact(user, "prescription", serialize(await ref.get())));
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/prescriptions/{id}/refill-requests",
    permission: "prescription:request-refill",
    summary: "Ask the prescriber for a refill",
    description: "Only for the caller's own current outpatient prescriptions with refills left. Notifies the prescriber; nothing else is stored.",
    tags: ["Prescriptions"],
    request: { params: idParam, body: RefillRequest },
    responses: { 202: RefillResponse },
    problems: ["404", "409"],
    async handler(req, res) {
      const { rx } = await loadPrescription(req.user, req.valid.params.id, "prescription:request-refill");
      if (rx.category !== "outpatient" || !isCurrent(rx) || rx.refills <= 0) {
        throw invalidTransition("Refills can only be requested for current outpatient prescriptions with refills left");
      }
      const batch = db.batch();
      notify(batch, rx.prescriberId, {
        title: "Refill requested",
        description: `${rx.patientName} requested a refill of ${rx.medication}`,
        type: "prescription",
        priority: "important",
        resource: { type: "prescription", id: rx.id },
      });
      await batch.commit();
      res.status(202).json({ status: "requested" });
    },
  });

  // --- Medication schedule ---------------------------------------------------------------------

  defineRoute(router, {
    method: "get",
    path: "/medication-schedule",
    permission: "medication-schedule:read",
    summary: "Scheduled doses for one day across the caller's inpatients",
    description:
      "Computed, not stored and not paginated. Current inpatient prescriptions of the caller's accessible admitted patients (nurses: plus their ward). PRN prescriptions are returned separately.",
    tags: ["Prescriptions"],
    request: { query: MedicationScheduleQuery },
    responses: { 200: MedicationSchedule },
    async handler(req, res) {
      res.json(await medicationSchedule(req.user, req.valid.query));
    },
  });

  // --- Administrations -------------------------------------------------------------------------

  defineRoute(router, {
    method: "get",
    path: "/medication-administrations",
    permission: "medication-administration:read",
    summary: "Administration history, newest first",
    description:
      "At least one of patientId, prescriptionId or performerId. Without a clinical patientId or prescriptionId, performerId must be me, and only administrations for patients still clinical to the caller are returned (the page may hold fewer than limit items).",
    tags: ["Prescriptions"],
    request: { query: AdministrationListQuery },
    responses: { 200: MedicationAdministrationPage },
    problems: ["404"],
    async handler(req, res) {
      const user = req.user;
      const { limit, cursor, patientId, prescriptionId, from, to, ...filters } = req.valid.query;
      let patient = await resolvePatientFilter(user, patientId, "medication-administration:read");
      if (prescriptionId) {
        const loaded = await loadPrescription(user, prescriptionId, "prescription:read");
        if (patient && loaded.rx.patientId !== patient.id) throw badRequest("prescriptionId belongs to another patient");
        authorize(user, "medication-administration:read", {}, { patient: loaded.patient });
        patient ??= loaded.patient;
      }
      const ctx = { patientId: patient?.id, prescriptionId };
      const s = scoped.medicationAdministrations(user, { ...filters, from: from && new Date(from), to: to && new Date(to) }, ctx);
      const page = await paginate(s, { limit, cursor });
      const visible = await visibleDocs(user, "medication-administration:read", page.docs, patient);
      res.json({ data: visible.map((d) => redact(user, "medication-administration", serialize(d))), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/medication-administrations",
    permission: "medication-administration:create",
    summary: "Chart a dose as given or not given",
    description:
      "A scheduled dose is locked in administrationSlots in the same transaction, so it has at most one live administration (409 already-charted until it is retracted).",
    tags: ["Prescriptions"],
    request: { body: AdministrationCreateRequest },
    responses: { 201: MedicationAdministration },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const { rx, patient } = await loadPrescription(user, body.prescriptionId);
      authorize(user, "medication-administration:create", {}, { patient });
      if (rx.status !== "active") throw invalidTransition(`The prescription is ${rx.status}`);

      const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
      if (occurredAt.getTime() > Date.now() + MINUTE) throw badRequest("occurredAt cannot be in the future");
      if (occurredAt.getTime() < Date.now() - DAY) throw badRequest("occurredAt can be at most 24 hours in the past");

      let scheduledFor = null;
      if (body.scheduledFor) {
        scheduledFor = new Date(body.scheduledFor);
        const { date } = sastParts(scheduledFor);
        if (!dosesOn(rx, date).some((d) => d.getTime() === scheduledFor.getTime())) {
          throw badRequest("scheduledFor is not a scheduled dose of this prescription");
        }
      } else if (rx.frequency !== "as-needed") {
        throw badRequest("scheduledFor is required for scheduled prescriptions");
      }

      const doc = {
        prescriptionId: rx.id,
        patientId: rx.patientId,
        patientName: rx.patientName,
        medication: rx.medication,
        dose: body.dose ?? rx.dose,
        route: rx.route,
        scheduledFor: scheduledFor && Timestamp.fromDate(scheduledFor),
        occurredAt: Timestamp.fromDate(occurredAt),
        status: body.status,
        statusReason: orNull(body.statusReason),
        notes: orNull(body.notes),
        performerId: user.id,
        performerName: user.name,
        ...createdFields(user),
      };
      const ref = administrations.doc();
      await db.runTransaction(async (tx) => {
        const lock = scheduledFor && slotRef(rx.id, scheduledFor);
        if (lock && (await tx.get(lock)).exists) {
          throw conflict("This dose has already been charted; retract it first", "already-charted");
        }
        if (lock) tx.create(lock, { prescriptionId: rx.id, scheduledFor: doc.scheduledFor, administrationId: ref.id });
        tx.create(ref, doc);
        writeAudit(tx, user, {
          action: "create",
          resource: { type: "medication-administration", id: ref.id },
          patientId: rx.patientId,
          changedFields: Object.keys(body),
        });
      });
      sendCreated(res, `/medication-administrations/${ref.id}`, redact(user, "medication-administration", serialize(await ref.get())));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/medication-administrations/{id}",
    permission: "medication-administration:retract",
    summary: "Mark an administration entered-in-error (performer only)",
    description: "Releases the scheduled dose's administrationSlots lock in the same transaction, so the dose can be charted again.",
    tags: ["Prescriptions"],
    request: { params: idParam, body: AdministrationRetractRequest },
    responses: { 200: MedicationAdministration },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const record = await getDoc("medicationAdministrations", req.valid.params.id);
      const patient = record && (await getDoc("patients", record.patientId));
      authorize(user, "medication-administration:retract", record, { patient });
      const ref = administrations.doc(record.id);
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (current.status === "entered-in-error") throw invalidTransition("Already entered-in-error");
        // Releasing the lock lets the dose be charted again (§2.9). Only this administration's lock.
        const lock = current.scheduledFor && slotRef(current.prescriptionId, current.scheduledFor.toDate());
        const lockSnap = lock && (await tx.get(lock));
        if (lockSnap?.exists && lockSnap.get("administrationId") === record.id) tx.delete(lock);
        tx.update(ref, { status: "entered-in-error", statusReason: req.valid.body.statusReason, ...updatedFields(user) });
        writeAudit(tx, user, {
          action: "status-change",
          resource: { type: "medication-administration", id: record.id },
          patientId: record.patientId,
          changedFields: ["status", "statusReason"],
        });
      });
      res.json(redact(user, "medication-administration", serialize(await ref.get())));
    },
  });
}

// --- Schedule computation (§2.9), shared with the nurse dashboard ------------------------------

export async function medicationSchedule(user, { date = sastDate(), departmentId } = {}) {
  if (departmentId && (user.role !== "nurse" || departmentId !== user.departmentId)) {
    throw forbidden("departmentId is for nurses and must be your own department");
  }
  let inpatients = (await fetchAll(scoped.patients(user, { admitted: true }), { limit: 300 })).map(raw);
  if (departmentId) inpatients = inpatients.filter((p) => p.admission?.departmentId === departmentId);
  const byPatient = new Map(inpatients.map((p) => [p.id, p]));

  const rxs = [];
  const ids = [...byPatient.keys()];
  for (let i = 0; i < ids.length; i += 30) {
    const docs = await fetchAll(queries.inpatientPrescriptions(ids.slice(i, i + 30)), { limit: 1000 });
    rxs.push(...docs.map(raw));
  }

  const doses = rxs.flatMap((rx) => dosesOn(rx, date).map((scheduledFor) => ({ rx, scheduledFor })));
  // Locks by deterministic ID, then the administrations they point to (two getAll calls).
  const locks = doses.length ? await db.getAll(...doses.map(({ rx, scheduledFor }) => slotRef(rx.id, scheduledFor))) : [];
  const adminIds = locks.filter((l) => l.exists).map((l) => l.get("administrationId"));
  const charted = adminIds.length ? await db.getAll(...adminIds.map((id) => administrations.doc(id))) : [];
  const records = new Map(charted.filter((s) => s.exists).map((s) => [s.id, raw(s)]));
  const now = Date.now();

  const data = doses.map(({ rx, scheduledFor }, i) => {
    const lock = locks[i];
    const record = lock.exists ? records.get(lock.get("administrationId")) : null;
    const t = scheduledFor.getTime();
    let status;
    if (record) status = record.status === "completed" ? "given" : "not-given";
    else if (now < t - DUE_WINDOW) status = "upcoming";
    else if (now <= t + DUE_WINDOW) status = "due";
    else status = "overdue";
    const patient = byPatient.get(rx.patientId);
    return {
      prescriptionId: rx.id,
      patientId: rx.patientId,
      patientName: rx.patientName,
      room: patient?.admission?.room ?? null,
      bed: patient?.admission?.bed ?? null,
      allergies: (patient?.allergies ?? []).map((a) => a.substance),
      medication: rx.medication,
      dose: rx.dose,
      route: rx.route,
      instructions: rx.instructions ?? null,
      scheduledFor: scheduledFor.toISOString(),
      status,
      ...(record && { administrationId: record.id }),
    };
  });
  data.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.patientName.localeCompare(b.patientName));
  const prn = rxs
    .filter((rx) => rx.frequency === "as-needed" && isCurrent(rx, date))
    .map((rx) => redact(user, "prescription", toJson(rx)));
  return { data, prn };
}
