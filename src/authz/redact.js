// Field-level rules (docs/domain-model.md §3.4), applied to every serialized document including
// list items. Writable field sets for PATCH /patients/{id} live here too.
import { HIDDEN_FIELDS } from "../models/common.js";
import { CLINICAL_FIELDS } from "../models/patient.js";
import { clinical, department, isStaff, patientAccess, userScope } from "./rules.js";

const omit = (doc, fields) => {
  const out = { ...doc };
  for (const f of fields) delete out[f];
  return out;
};

const stripHidden = (doc) => omit(doc, HIDDEN_FIELDS);

const REDACTORS = {
  // ctx.access may be passed when the caller already computed it.
  patient(user, doc, ctx) {
    const access = ctx.access ?? patientAccess(user, doc);
    if (access === "self") return doc;
    if (access === "clinical") return omit(doc, ["identifier"]);
    if (access === "administrative") return omit(doc, CLINICAL_FIELDS);
    return omit(doc, ["identifier", ...CLINICAL_FIELDS, "admission"]);
  },

  user(user, doc) {
    const isSelf = doc.id === user.id;
    const admin = userScope(user, doc);
    let out = doc;
    if (!isSelf && !admin) out = omit(out, ["identifier", "emergencyContact", "phone", "email"]);
    if (user.role !== "admin") out = omit(out, ["lastSignInAt"]);
    return out;
  },

  practitionerSummary(user, doc) {
    return user.role === "patient" ? omit(doc, ["email"]) : doc;
  },

  // reason/cancellationReason: self, or clinical access to the appointment's patient (ctx.patient).
  // Never admins, never a nurse who sees the appointment only through department scope.
  appointment(user, doc, ctx) {
    const visible =
      (user.role === "patient" && (doc.patientUserId === user.id || patientAccess(user, ctx.patient) === "self")) ||
      clinical(user, ctx.patient);
    return visible ? doc : omit(doc, ["reason", "cancellationReason"]);
  },

  // handoverNote: the owner, and doctors and nurses in the shift's department. Never admins.
  shift(user, doc) {
    const visible = doc.staffId === user.id || (isStaff(user) && department(user, doc));
    return visible ? doc : omit(doc, ["handoverNote"]);
  },

  conversation(user, doc, ctx) {
    return { ...doc, unreadCount: ctx.unreadCount ?? 0 };
  },
};

export function redact(user, type, doc, context = {}) {
  if (!doc) return doc;
  const base = stripHidden(doc);
  const fn = REDACTORS[type];
  return fn ? fn(user, base, context) : base;
}

// --- Writable fields ----------------------------------------------------------------------------

const SELF_PATIENT_FIELDS = ["name", "givenName", "familyName", "phone", "email", "address", "emergencyContact"];
const CLINICAL_PATIENT_FIELDS = [
  ...SELF_PATIENT_FIELDS,
  "birthDate",
  "sex",
  "folderNumber",
  "bloodType",
  "allergies",
  "noKnownAllergies",
  "chronicConditions",
  "acuity",
];
const ADMIN_PATIENT_FIELDS = [
  ...SELF_PATIENT_FIELDS,
  "birthDate",
  "sex",
  "folderNumber",
  "identifier",
  "status",
];

// The fields `user` may PATCH on `resource` (§3.4). Anything else returns 403 naming the field.
export function writableFields(user, type, resource) {
  if (type !== "patient") return new Set();
  const access = patientAccess(user, resource);
  if (access === "self") {
    return new Set([...SELF_PATIENT_FIELDS, ...(resource.identifier ? [] : ["identifier"])]);
  }
  if (access === "clinical") {
    return new Set([...CLINICAL_PATIENT_FIELDS, ...(user.role === "doctor" ? ["status", "deceasedAt"] : [])]);
  }
  if (access === "administrative") {
    return new Set([...ADMIN_PATIENT_FIELDS, ...(user.facilityId == null ? ["facilityId"] : [])]);
  }
  return new Set();
}
