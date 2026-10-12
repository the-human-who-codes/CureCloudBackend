// Patients, care team, admission and vitals (docs/domain-model.md §2.5, §2.6, §4.2 "Patients").
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebase.js";
import {
  authorize,
  getDoc,
  loadPatient,
  patientAccess,
  queries,
  redact,
  scoped,
  systemAdmin,
  ward,
  writableFields,
} from "../../authz/index.js";
import { writeAudit } from "../../lib/audit.js";
import { DAY, MINUTE } from "../../lib/dates.js";
import { fetchInTx, paginate } from "../../lib/firestore-query.js";
import { identifierHash } from "../../lib/identifiers.js";
import { notify } from "../../lib/notify.js";
import { practitionerSummaries } from "../../lib/practitioners.js";
import { badRequest, conflict, fieldForbidden, forbidden, invalidTransition, notFound } from "../../lib/problem.js";
import { defineRoute } from "../../lib/route.js";
import { raw, serialize, toJson } from "../../lib/serialize.js";
import { createdFields, nameLower, orNull, sendCreated, updatedFields } from "../../lib/write.js";
import {
  AdmissionUpdateRequest,
  AdmitRequest,
  CLINICAL_FIELDS,
  CareTeamAddRequest,
  CareTeamParams,
  DischargeRequest,
  MEASUREMENTS,
  Patient,
  PatientCreateRequest,
  PatientListQuery,
  PatientPage,
  PatientUpdateRequest,
  PractitionerSummaryList,
  VitalSigns,
  VitalSignsPage,
  VitalsCreateRequest,
  VitalsListQuery,
  VitalsRetractRequest,
  id,
  idParam,
  parseZaId,
  z,
} from "../../models/index.js";

const patients = db.collection("patients");

const conditionCategories = (conditions = []) =>
  [...new Set(conditions.map((c) => c.code?.slice(0, 3)).filter(Boolean))].sort();

// A complete v2 patient document with defaults (§2.5). Used by POST /me, POST /patients and the seed.
export function newPatientDoc(actor, f) {
  return {
    userId: f.userId ?? null,
    facilityId: f.facilityId ?? null,
    folderNumber: orNull(f.folderNumber),
    status: "active",
    deceasedAt: null,
    name: f.name,
    nameLower: nameLower(f.name),
    givenName: orNull(f.givenName),
    familyName: orNull(f.familyName),
    birthDate: orNull(f.birthDate),
    sex: f.sex ?? "unknown",
    phone: orNull(f.phone),
    email: orNull(f.email),
    address: orNull(f.address),
    emergencyContact: orNull(f.emergencyContact),
    identifier: orNull(f.identifier),
    bloodType: orNull(f.bloodType),
    allergies: f.allergies ?? [],
    noKnownAllergies: f.noKnownAllergies ?? false,
    chronicConditions: f.chronicConditions ?? [],
    conditionCategories: conditionCategories(f.chronicConditions),
    acuity: f.acuity ?? "stable",
    admission: null,
    admitted: false,
    careTeam: f.careTeam ?? [],
    latestVitals: null,
    ...createdFields(actor),
  };
}

// Fills birthDate and sex from a South African ID number when they are missing (§2 shared types).
function deriveFromIdentifier(fields, existing = {}) {
  if (fields.identifier?.type !== "za-id") return fields;
  const derived = parseZaId(fields.identifier.value);
  const out = { ...fields };
  if (!out.birthDate && !existing.birthDate) out.birthDate = derived.birthDate;
  if (!out.sex && (!existing.sex || existing.sex === "unknown")) out.sex = derived.sex;
  return out;
}

const identifierRef = (identifier) => db.collection("patientIdentifiers").doc(identifierHash(identifier));

// Reserves the identifier for the patient inside a transaction (reads happen before writes).
async function reserveIdentifier(tx, identifier, patientId) {
  const ref = identifierRef(identifier);
  const snap = await tx.get(ref);
  if (snap.exists && snap.get("patientId") !== patientId) {
    throw conflict("A patient with this identity number is already registered", "duplicate-identifier");
  }
  return snap.exists ? null : ref;
}

export const patientResponse = (user, patient) => redact(user, "patient", toJson(patient));

const reload = async (patientId) => raw(await patients.doc(patientId).get());

function rebuildLatestVitals(panels) {
  const sorted = [...panels].sort((a, b) => b.recordedAt.toMillis() - a.recordedAt.toMillis());
  if (!sorted.length) return null;
  const latest = {};
  for (const panel of sorted) {
    for (const k of MEASUREMENTS) if (latest[k] === undefined && panel[k] != null) latest[k] = panel[k];
  }
  return { ...latest, recordedAt: sorted[0].recordedAt };
}

async function loadDepartment(departmentId) {
  const dept = await getDoc("departments", departmentId);
  if (!dept || dept.status !== "active") throw badRequest("departmentId must be an active department");
  return dept;
}

async function checkAttendingDoctor(doctorId) {
  if (!doctorId) return;
  const doctor = await getDoc("users", doctorId);
  if (doctor?.role !== "doctor" || doctor.status !== "active") {
    throw badRequest("attendingDoctorId must be an active doctor");
  }
}

export function register(router) {
  defineRoute(router, {
    method: "get",
    path: "/patients",
    permission: "patient:list",
    summary: "List patients the caller can access, sorted by name",
    description:
      "Doctors: their care team. Nurses: care team plus patients admitted to their department. Admins: their facility (system admins: everything or ?facilityId=). q combines only with acuity; admitted combines with neither.",
    tags: ["Patients"],
    request: { query: PatientListQuery },
    responses: { 200: PatientPage },
    async handler(req, res) {
      const { limit, cursor, ...filters } = req.valid.query;
      const page = await paginate(scoped.patients(req.user, filters), { limit, cursor });
      res.json({ data: page.docs.map((d) => patientResponse(req.user, raw(d))), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/patients",
    permission: "patient:create",
    summary: "Register a patient (walk-in, no account needed)",
    description:
      "Created in the caller's facility. Doctor and nurse creators join the care team. Admins may not send clinical fields. 409 duplicate-identifier when the ID number is already registered.",
    tags: ["Patients"],
    request: { body: PatientCreateRequest },
    responses: { 201: Patient },
    problems: ["409"],
    async handler(req, res) {
      const user = req.user;
      const body = deriveFromIdentifier(req.valid.body);
      if (user.role === "admin") {
        const clinicalField = CLINICAL_FIELDS.find((f) => body[f] !== undefined);
        if (clinicalField) throw fieldForbidden(clinicalField);
      }
      if (body.facilityId !== undefined && !systemAdmin(user)) {
        if (body.facilityId !== user.facilityId) throw fieldForbidden("facilityId");
      }
      if (body.facilityId && !(await getDoc("facilities", body.facilityId))) {
        throw badRequest("facilityId must be an existing facility");
      }
      const facilityId = systemAdmin(user) ? (body.facilityId ?? null) : (user.facilityId ?? null);
      const ref = patients.doc();
      const doc = newPatientDoc(user, {
        ...body,
        facilityId,
        careTeam: user.role === "admin" ? [] : [user.id],
      });
      await db.runTransaction(async (tx) => {
        const lock = body.identifier ? await reserveIdentifier(tx, body.identifier, ref.id) : null;
        if (lock) tx.create(lock, { patientId: ref.id, ...createdFields(user) });
        tx.create(ref, doc);
        writeAudit(tx, user, {
          action: "create",
          resource: { type: "patient", id: ref.id },
          patientId: ref.id,
          changedFields: Object.keys(req.valid.body),
        });
      });
      sendCreated(res, `/patients/${ref.id}`, patientResponse(user, await reload(ref.id)));
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/patients/{id}",
    permission: "patient:read",
    summary: "Get a patient (redacted per access level)",
    tags: ["Patients"],
    request: { params: idParam },
    responses: { 200: Patient },
    problems: ["404"],
    async handler(req, res) {
      res.json(patientResponse(req.user, await loadPatient(req.user, req.valid.params.id)));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/patients/{id}",
    permission: "patient:update",
    summary: "Update a patient using the caller's writable field set",
    description:
      "self: name, contact data, and identifier while it is unset. clinical: demographics and clinical fields (doctors also status). administrative: demographics, identifier and active/inactive status (system admins also facilityId). Any other field returns 403 naming it.",
    tags: ["Patients"],
    request: { params: idParam, body: PatientUpdateRequest },
    responses: { 200: Patient },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const patientId = req.valid.params.id;
      const patient = await loadPatient(user, patientId, "patient:update");
      const access = patientAccess(user, patient);
      const writable = writableFields(user, "patient", patient);
      const denied = Object.keys(req.valid.body).find((k) => !writable.has(k));
      if (denied) throw fieldForbidden(denied);

      const body = deriveFromIdentifier(req.valid.body, patient);
      if (access === "administrative" && body.status === "deceased") {
        throw forbidden("Administrators can only set a patient active or inactive");
      }
      if (body.facilityId && !(await getDoc("facilities", body.facilityId))) {
        throw badRequest("facilityId must be an existing facility");
      }
      const update = { ...body };
      const status = body.status ?? patient.status;
      if (status === "deceased" && !(body.deceasedAt ?? patient.deceasedAt)) {
        throw badRequest("deceasedAt is required when status is deceased");
      }
      if (body.status && body.status !== "deceased") update.deceasedAt = null;
      if (body.name) update.nameLower = nameLower(body.name);
      if (body.chronicConditions) update.conditionCategories = conditionCategories(body.chronicConditions);
      const allergies = body.allergies ?? patient.allergies ?? [];
      if (allergies.length && (body.noKnownAllergies ?? patient.noKnownAllergies)) {
        if (body.noKnownAllergies) throw badRequest("noKnownAllergies can only be true when allergies is empty");
        update.noKnownAllergies = false;
      }

      await db.runTransaction(async (tx) => {
        const lock = body.identifier ? await reserveIdentifier(tx, body.identifier, patientId) : null;
        if (lock) {
          tx.create(lock, { patientId, ...createdFields(user) });
          if (patient.identifier) tx.delete(identifierRef(patient.identifier));
        }
        tx.update(patients.doc(patientId), { ...update, ...updatedFields(user) });
        if (access === "self" && body.name) {
          tx.update(db.collection("users").doc(user.id), { name: body.name, nameLower: nameLower(body.name), ...updatedFields(user) });
        }
        writeAudit(tx, user, {
          action: body.status ? "status-change" : "update",
          resource: { type: "patient", id: patientId },
          patientId,
          changedFields: Object.keys(req.valid.body),
        });
      });
      res.json(patientResponse(user, await reload(patientId)));
    },
  });

  // --- Care team --------------------------------------------------------------------------------

  const careTeamBody = async (user, patient) => {
    const ids = patient.careTeam ?? [];
    const snaps = ids.length ? await db.getAll(...ids.map((uid) => db.collection("users").doc(uid))) : [];
    return { data: await practitionerSummaries(user, snaps.filter((s) => s.exists).map(raw)) };
  };

  defineRoute(router, {
    method: "get",
    path: "/patients/{id}/care-team",
    permission: "patient:read",
    summary: "The patient's care team (not paginated, at most 50)",
    tags: ["Patients"],
    request: { params: idParam },
    responses: { 200: PractitionerSummaryList },
    problems: ["404"],
    async handler(req, res) {
      res.json(await careTeamBody(req.user, await loadPatient(req.user, req.valid.params.id)));
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/patients/{id}/care-team",
    permission: "patient:manage-care-team",
    summary: "Add a doctor or nurse to the care team",
    description: "Doctors may add while they are on the care team; admins within their facility. Notifies the added staff member.",
    tags: ["Patients"],
    request: { params: idParam, body: CareTeamAddRequest },
    responses: { 201: PractitionerSummaryList },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const patientId = req.valid.params.id;
      const patient = await loadPatient(user, patientId, "patient:read");
      authorize(user, "patient:manage-care-team", patient);
      const { userId } = req.valid.body;
      const staff = await getDoc("users", userId);
      if (!["doctor", "nurse"].includes(staff?.role) || staff.status !== "active") {
        throw badRequest("userId must be an active doctor or nurse");
      }
      if (!patient.careTeam.includes(userId)) {
        if (patient.careTeam.length >= 50) throw conflict("The care team is full (50 members)");
        const batch = db.batch();
        batch.update(patients.doc(patientId), { careTeam: FieldValue.arrayUnion(userId), ...updatedFields(user) });
        writeAudit(batch, user, {
          action: "create",
          resource: { type: "care-team", id: userId },
          patientId,
          changedFields: ["careTeam"],
        });
        notify(batch, userId, {
          title: "Added to a care team",
          description: `You were added to the care team of ${patient.name}`,
          type: "system",
          resource: { type: "patient", id: patientId },
        });
        await batch.commit();
      }
      sendCreated(res, `/patients/${patientId}/care-team`, await careTeamBody(user, await reload(patientId)));
    },
  });

  defineRoute(router, {
    method: "delete",
    path: "/patients/{id}/care-team/{userId}",
    permission: "patient:manage-care-team",
    summary: "Remove a member from the care team (admins only)",
    tags: ["Patients"],
    request: { params: CareTeamParams },
    responses: { 204: { schema: undefined, description: "Removed" } },
    problems: ["404"],
    async handler(req, res) {
      const user = req.user;
      const { id: patientId, userId } = req.valid.params;
      const patient = await loadPatient(user, patientId, "patient:read");
      if (user.role !== "admin") throw forbidden("Doctors can add to the care team but not remove");
      authorize(user, "patient:manage-care-team", patient);
      if (!patient.careTeam.includes(userId)) throw notFound("care team member");
      const batch = db.batch();
      batch.update(patients.doc(patientId), { careTeam: FieldValue.arrayRemove(userId), ...updatedFields(user) });
      writeAudit(batch, user, { action: "delete", resource: { type: "care-team", id: userId }, patientId, changedFields: ["careTeam"] });
      await batch.commit();
      res.status(204).end();
    },
  });

  // --- Admission --------------------------------------------------------------------------------

  defineRoute(router, {
    method: "post",
    path: "/patients/{id}/admission",
    permission: "patient:admit",
    summary: "Admit the patient (doctors and admins)",
    tags: ["Patients"],
    request: { params: idParam, body: AdmitRequest },
    responses: { 201: Patient },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const patientId = req.valid.params.id;
      const patient = await loadPatient(user, patientId, "patient:admit");
      if (user.role === "nurse") throw forbidden("Nurses can only move a patient's ward, room or bed");
      const body = req.valid.body;
      const dept = await loadDepartment(body.departmentId);
      if (patient.facilityId && dept.facilityId !== patient.facilityId) {
        throw badRequest("The department is in another facility");
      }
      if (user.role === "admin" && !systemAdmin(user) && dept.facilityId !== user.facilityId) {
        throw badRequest("The department is in another facility");
      }
      await checkAttendingDoctor(body.attendingDoctorId);
      const ref = patients.doc(patientId);
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (current.admission) throw conflict("The patient is already admitted");
        tx.update(ref, {
          admission: {
            departmentId: dept.id,
            departmentName: dept.name,
            ward: orNull(body.ward),
            room: orNull(body.room),
            bed: orNull(body.bed),
            admittedAt: Timestamp.now(),
            admittedBy: user.id,
            attendingDoctorId: orNull(body.attendingDoctorId),
          },
          admitted: true,
          ...(current.facilityId ? {} : { facilityId: dept.facilityId }),
          ...updatedFields(user),
        });
        writeAudit(tx, user, { action: "create", resource: { type: "admission", id: patientId }, patientId, changedFields: ["admission"] });
      });
      sendCreated(res, `/patients/${patientId}/admission`, patientResponse(user, await reload(patientId)));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/patients/{id}/admission",
    permission: "patient:admit",
    summary: "Transfer or correct the current admission",
    description: "Nurses may change ward, room and bed for patients admitted to their own department only.",
    tags: ["Patients"],
    request: { params: idParam, body: AdmissionUpdateRequest },
    responses: { 200: Patient },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const patientId = req.valid.params.id;
      const patient = await loadPatient(user, patientId, "patient:admit");
      const body = req.valid.body;
      if (!patient.admission) throw invalidTransition("The patient is not admitted");
      if (user.role === "nurse") {
        const denied = Object.keys(body).find((k) => !["ward", "room", "bed"].includes(k));
        if (denied) throw fieldForbidden(denied);
        if (!ward(user, patient)) throw forbidden("Nurses can only move patients within their own department");
      }
      const update = {};
      for (const key of ["ward", "room", "bed", "attendingDoctorId"]) {
        if (body[key] !== undefined) update[`admission.${key}`] = body[key];
      }
      if (body.departmentId && body.departmentId !== patient.admission.departmentId) {
        const dept = await loadDepartment(body.departmentId);
        if (dept.facilityId !== patient.facilityId) throw badRequest("The department is in another facility");
        update["admission.departmentId"] = dept.id;
        update["admission.departmentName"] = dept.name;
      }
      await checkAttendingDoctor(body.attendingDoctorId);
      const batch = db.batch();
      batch.update(patients.doc(patientId), { ...update, ...updatedFields(user) });
      writeAudit(batch, user, { action: "update", resource: { type: "admission", id: patientId }, patientId, changedFields: Object.keys(body) });
      await batch.commit();
      res.json(patientResponse(user, await reload(patientId)));
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/patients/{id}/admission/discharge",
    permission: "patient:admit",
    summary: "Discharge the patient (doctors and admins)",
    description: "Moves the closed admission to the patients/{id}/admissions history and sets admission to null.",
    tags: ["Patients"],
    request: { params: idParam, body: DischargeRequest },
    responses: { 200: Patient },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const patientId = req.valid.params.id;
      await loadPatient(user, patientId, "patient:admit");
      if (user.role === "nurse") throw forbidden("Only doctors and administrators can discharge");
      const ref = patients.doc(patientId);
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (!current.admission) throw invalidTransition("The patient is not admitted");
        tx.set(ref.collection("admissions").doc(), {
          ...current.admission,
          dischargedAt: Timestamp.now(),
          dischargedBy: user.id,
          dischargeNote: orNull(req.valid.body.dischargeNote),
          schemaVersion: 2,
        });
        tx.update(ref, { admission: null, admitted: false, ...updatedFields(user) });
        writeAudit(tx, user, { action: "status-change", resource: { type: "admission", id: patientId }, patientId, changedFields: ["admission"] });
      });
      res.json(patientResponse(user, await reload(patientId)));
    },
  });

  // --- Vitals -----------------------------------------------------------------------------------

  defineRoute(router, {
    method: "get",
    path: "/patients/{id}/vitals",
    permission: "vitals:read",
    summary: "Vital signs history, newest first",
    description: "Excludes entered-in-error panels unless ?status=entered-in-error (clinical access only).",
    tags: ["Patients"],
    request: { params: idParam, query: VitalsListQuery },
    responses: { 200: VitalSignsPage },
    problems: ["404"],
    async handler(req, res) {
      const patient = await loadPatient(req.user, req.valid.params.id);
      authorize(req.user, "vitals:read", {}, { patient });
      const { limit, cursor, ...filters } = req.valid.query;
      const page = await paginate(scoped.vitals(req.user, patient.id, filters), { limit, cursor });
      res.json({ data: page.docs.map((d) => redact(req.user, "vitals", serialize(d))), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/patients/{id}/vitals",
    permission: "vitals:create",
    summary: "Record a vital signs panel",
    description: "Also rebuilds patient.latestVitals in the same transaction.",
    tags: ["Patients"],
    request: { params: idParam, body: VitalsCreateRequest },
    responses: { 201: VitalSigns },
    problems: ["404"],
    async handler(req, res) {
      const user = req.user;
      const patient = await loadPatient(user, req.valid.params.id);
      authorize(user, "vitals:create", {}, { patient });
      const { recordedAt: at, notes, ...measurements } = req.valid.body;
      const recordedAt = at ? new Date(at) : new Date();
      if (recordedAt.getTime() > Date.now() + MINUTE) throw badRequest("recordedAt cannot be in the future");
      if (recordedAt.getTime() < Date.now() - 7 * DAY) throw badRequest("recordedAt can be at most 7 days in the past");
      const ref = patients.doc(patient.id);
      const panelRef = ref.collection("vitals").doc();
      const panel = {
        patientId: patient.id,
        recordedAt: Timestamp.fromDate(recordedAt),
        status: "final",
        statusReason: null,
        ...Object.fromEntries(MEASUREMENTS.map((k) => [k, orNull(measurements[k])])),
        notes: orNull(notes),
        createdByName: user.name,
        ...createdFields(user),
      };
      await db.runTransaction(async (tx) => {
        const recent = await fetchInTx(tx, queries.recentFinalVitals(patient.id), { limit: 10 });
        tx.create(panelRef, panel);
        tx.update(ref, { latestVitals: rebuildLatestVitals([panel, ...recent.map((d) => d.data())]), ...updatedFields(user) });
        writeAudit(tx, user, {
          action: "create",
          resource: { type: "vitals", id: panelRef.id },
          patientId: patient.id,
          changedFields: Object.keys(req.valid.body),
        });
      });
      sendCreated(res, `/patients/${patient.id}/vitals/${panelRef.id}`, redact(user, "vitals", serialize(await panelRef.get())));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/patients/{id}/vitals/{vitalsId}",
    permission: "vitals:retract",
    summary: "Mark a vitals panel entered-in-error (author only)",
    tags: ["Patients"],
    request: { params: z.object({ id, vitalsId: id }), body: VitalsRetractRequest },
    responses: { 200: VitalSigns },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const { id: patientId, vitalsId } = req.valid.params;
      const patient = await loadPatient(user, patientId);
      const panelRef = patients.doc(patientId).collection("vitals").doc(vitalsId);
      const panel = raw(await panelRef.get());
      authorize(user, "vitals:retract", panel, { patient }, { what: "vitals" });
      if (panel.status !== "final") throw invalidTransition("The panel is already entered-in-error");
      await db.runTransaction(async (tx) => {
        const recent = await fetchInTx(tx, queries.recentFinalVitals(patientId), { limit: 11 });
        const remaining = recent.filter((d) => d.id !== vitalsId).slice(0, 10).map((d) => d.data());
        tx.update(panelRef, { status: "entered-in-error", statusReason: req.valid.body.statusReason, ...updatedFields(user) });
        tx.update(patients.doc(patientId), { latestVitals: rebuildLatestVitals(remaining), ...updatedFields(user) });
        writeAudit(tx, user, {
          action: "status-change",
          resource: { type: "vitals", id: vitalsId },
          patientId,
          changedFields: ["status", "statusReason"],
        });
      });
      res.json(redact(user, "vitals", serialize(await panelRef.get())));
    },
  });
}
