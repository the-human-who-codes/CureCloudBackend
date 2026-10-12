// Medical records (docs/domain-model.md §2.11, §4.2 "Medical records").
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebase.js";
import { authorize, getDoc, loadPatient, redact, resolvePatientFilter, scoped } from "../../authz/index.js";
import { writeAudit } from "../../lib/audit.js";
import { MINUTE } from "../../lib/dates.js";
import { paginate } from "../../lib/firestore-query.js";
import { notify } from "../../lib/notify.js";
import { badRequest, conflict, forbidden, invalidTransition } from "../../lib/problem.js";
import { defineRoute } from "../../lib/route.js";
import { serialize, toJson } from "../../lib/serialize.js";
import { createdFields, orNull, sendCreated, updatedFields } from "../../lib/write.js";
import {
  AddendumCreateRequest,
  CONTENT_FIELDS,
  MedicalRecord,
  MedicalRecordCreateRequest,
  MedicalRecordListQuery,
  MedicalRecordPage,
  MedicalRecordUpdateRequest,
  hasContent,
  idParam,
} from "../../models/index.js";

const records = db.collection("medicalRecords");

function effectiveAt(value) {
  const at = value ? new Date(value) : new Date();
  if (at.getTime() > Date.now() + MINUTE) throw badRequest("effectiveAt cannot be in the future");
  return Timestamp.fromDate(at);
}

// Patients are told a record exists, never what it says (§2.11).
function notifyFinal(writer, patient, record, recordId) {
  notify(writer, patient?.userId, {
    title: `New medical record: ${record.title}`.slice(0, 120),
    description: `${record.authorName} added a record to your file`,
    type: "medical-record",
    resource: { type: "medical-record", id: recordId },
  });
}

async function loadRecord(user, id, permission = "medical-record:read") {
  const record = await getDoc("medicalRecords", id);
  const patient = record && (await getDoc("patients", record.patientId));
  authorize(user, permission, record, { patient }, { what: "medical record" });
  return { record, patient };
}

export function register(router) {
  defineRoute(router, {
    method: "get",
    path: "/medical-records",
    permission: "medical-record:read",
    summary: "List medical records, newest effectiveAt first",
    description:
      "Patients: their own, final and amended only. Doctors and nurses without patientId: authorId defaults to and must be me.",
    tags: ["Medical records"],
    request: { query: MedicalRecordListQuery },
    responses: { 200: MedicalRecordPage },
    problems: ["404"],
    async handler(req, res) {
      const { limit, cursor, patientId, ...filters } = req.valid.query;
      const patient = await resolvePatientFilter(req.user, patientId, "medical-record:read");
      const page = await paginate(scoped.medicalRecords(req.user, filters, { patientId: patient?.id }), { limit, cursor });
      res.json({ data: page.docs.map((d) => redact(req.user, "medical-record", serialize(d))), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/medical-records",
    permission: "medical-record:create",
    summary: "Write a medical record",
    description: "Nurses may only create nursing-note records. Finalising notifies the patient without clinical content.",
    tags: ["Medical records"],
    request: { body: MedicalRecordCreateRequest },
    responses: { 201: MedicalRecord },
    problems: ["404"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const patient = await loadPatient(user, body.patientId);
      authorize(user, "medical-record:create", {}, { patient });
      if (user.role === "nurse" && body.category !== "nursing-note") throw forbidden("Nurses can only write nursing notes");
      if (body.appointmentId) {
        const appt = await getDoc("appointments", body.appointmentId);
        if (appt?.patientId !== patient.id) throw badRequest("appointmentId does not belong to this patient");
      }
      const ref = records.doc();
      const doc = {
        patientId: patient.id,
        patientName: patient.name,
        authorId: user.id,
        authorName: user.name,
        authorRole: user.role,
        category: body.category,
        title: body.title,
        effectiveAt: effectiveAt(body.effectiveAt),
        status: body.status,
        statusReason: null,
        ...Object.fromEntries(CONTENT_FIELDS.map((k) => [k, k === "labResults" ? (body.labResults ?? []) : orNull(body[k])])),
        appointmentId: orNull(body.appointmentId),
        addenda: [],
        ...createdFields(user),
      };
      const batch = db.batch();
      batch.create(ref, doc);
      writeAudit(batch, user, {
        action: "create",
        resource: { type: "medical-record", id: ref.id },
        patientId: patient.id,
        changedFields: Object.keys(body),
      });
      if (body.status === "final") notifyFinal(batch, patient, doc, ref.id);
      await batch.commit();
      sendCreated(res, `/medical-records/${ref.id}`, redact(user, "medical-record", serialize(await ref.get())));
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/medical-records/{id}",
    permission: "medical-record:read",
    summary: "Get a medical record",
    description: "Preliminary and entered-in-error records are not visible to patients (404).",
    tags: ["Medical records"],
    request: { params: idParam },
    responses: { 200: MedicalRecord },
    problems: ["404"],
    async handler(req, res) {
      const { record } = await loadRecord(req.user, req.valid.params.id);
      res.json(redact(req.user, "medical-record", toJson(record)));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/medical-records/{id}",
    permission: "medical-record:update",
    summary: "Edit a preliminary record, finalise it, or mark it entered-in-error (author only)",
    description: "final and amended records are immutable (409 record-immutable); append an addendum instead.",
    tags: ["Medical records"],
    request: { params: idParam, body: MedicalRecordUpdateRequest },
    responses: { 200: MedicalRecord },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const { record, patient } = await loadRecord(user, req.valid.params.id, "medical-record:update");
      const ref = records.doc(record.id);
      const update = { ...updatedFields(user) };

      if (body.status === "entered-in-error") {
        if (Object.keys(body).some((k) => !["status", "statusReason"].includes(k))) {
          throw badRequest("entered-in-error cannot be combined with content changes");
        }
        if (record.status === "entered-in-error") throw invalidTransition("Already entered-in-error");
        Object.assign(update, { status: "entered-in-error", statusReason: body.statusReason });
      } else {
        if (record.status !== "preliminary") throw conflict(`A ${record.status} record is immutable; add an addendum`, "record-immutable");
        if (body.statusReason) throw badRequest("statusReason is only used with entered-in-error");
        if (user.role === "nurse" && body.category && body.category !== "nursing-note") {
          throw forbidden("Nurses can only write nursing notes");
        }
        const { status, effectiveAt: at, ...content } = body;
        Object.assign(update, content);
        if (at) update.effectiveAt = effectiveAt(at);
        if (status === "final") update.status = "final";
        if (!hasContent({ ...record, ...content })) {
          throw badRequest("At least one of diagnosis, findings, treatment or labResults is required");
        }
      }
      const batch = db.batch();
      batch.update(ref, update);
      writeAudit(batch, user, {
        action: body.status ? "status-change" : "update",
        resource: { type: "medical-record", id: record.id },
        patientId: record.patientId,
        changedFields: Object.keys(body),
      });
      if (update.status === "final") notifyFinal(batch, patient, { ...record, ...update }, record.id);
      await batch.commit();
      res.json(redact(user, "medical-record", serialize(await ref.get())));
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/medical-records/{id}/addenda",
    permission: "medical-record:update",
    summary: "Append an addendum to a final or amended record (author only)",
    description: "Sets status to amended. Addenda are append-only.",
    tags: ["Medical records"],
    request: { params: idParam, body: AddendumCreateRequest },
    responses: { 201: MedicalRecord },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const { record } = await loadRecord(user, req.valid.params.id, "medical-record:update");
      if (!["final", "amended"].includes(record.status)) {
        throw invalidTransition("Addenda can only be added to final or amended records");
      }
      const ref = records.doc(record.id);
      const batch = db.batch();
      batch.update(ref, {
        addenda: FieldValue.arrayUnion({
          text: req.valid.body.text,
          authorId: user.id,
          authorName: user.name,
          createdAt: Timestamp.now(),
        }),
        status: "amended",
        ...updatedFields(user),
      });
      writeAudit(batch, user, {
        action: "update",
        resource: { type: "medical-record", id: record.id },
        patientId: record.patientId,
        changedFields: ["addenda", "status"],
      });
      await batch.commit();
      sendCreated(res, `/medical-records/${record.id}`, redact(user, "medical-record", serialize(await ref.get())));
    },
  });
}
