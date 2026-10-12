// Relationship checks per permission and the denial semantics of §3.5:
//   role lacks the permission                 → 403 forbidden
//   permission, but no relationship (hidden)  → 404 not-found (IDs cannot be probed)
//   resource visible, action not allowed      → 403 forbidden
import { forbidden, notFound } from "../lib/problem.js";
import { hasPermission } from "./permissions.js";
import {
  author,
  clinical,
  department,
  facility,
  participant,
  patientAccess,
  sameFacility,
  systemAdmin,
  userScope,
} from "./rules.js";

const selfOrClinical = (user, patient) => ["self", "clinical"].includes(patientAccess(user, patient));

// Every rule receives (user, resource, ctx). Child resources get their patient as ctx.patient.
const RULES = {
  "patient:read": (u, p) => patientAccess(u, p) !== null,
  "patient:update": (u, p) => patientAccess(u, p) !== null,
  "patient:read-identifier": (u, p) => ["self", "administrative"].includes(patientAccess(u, p)),
  "patient:manage-care-team": (u, p) =>
    u.role === "doctor" ? Boolean(p.careTeam?.includes(u.id)) : patientAccess(u, p) === "administrative",
  "patient:admit": (u, p) => ["clinical", "administrative"].includes(patientAccess(u, p)),

  "vitals:read": (u, _v, { patient }) => selfOrClinical(u, patient),
  "vitals:create": (u, _v, { patient }) => clinical(u, patient),
  "vitals:retract": (u, v) => author(u, v),

  "appointment:read": (u, a, { patient } = {}) => {
    switch (u.role) {
      case "patient":
        return a.patientUserId === u.id || patientAccess(u, patient) === "self";
      case "doctor":
        return a.doctorId === u.id || clinical(u, patient);
      case "nurse":
        return clinical(u, patient) || department(u, a);
      case "admin":
        return facility(u, a);
      default:
        return false;
    }
  },
  "appointment:create": (u, _a, { patient }) => patientAccess(u, patient) !== null,

  "prescription:read": (u, _rx, { patient }) => selfOrClinical(u, patient),
  "prescription:create": (u, _rx, { patient }) => u.role === "doctor" && clinical(u, patient),
  "prescription:update": (u, rx, { patient }) => rx.prescriberId === u.id || clinical(u, patient),
  "prescription:request-refill": (u, _rx, { patient }) => patientAccess(u, patient) === "self",

  "medication-administration:read": (u, _m, { patient }) => selfOrClinical(u, patient),
  "medication-administration:create": (u, _m, { patient }) => clinical(u, patient),
  "medication-administration:retract": (u, m) => m.performerId === u.id,

  "medical-record:read": (u, r, { patient }) => {
    const access = patientAccess(u, patient);
    if (access === "self") return ["final", "amended"].includes(r.status);
    return access === "clinical";
  },
  "medical-record:create": (u, _r, { patient }) => clinical(u, patient),
  "medical-record:update": (u, r) => r.authorId === u.id,

  // Patient tasks always need clinical access to the task's patient at request time (§2.10), on
  // top of the department, assignee or creator scope. Ward-level tasks have no patient.
  "care-task:read": (u, t, { patient } = {}) => {
    if (t.patientId && !clinical(u, patient)) return false;
    if (u.role === "nurse") return department(u, t) || t.assigneeId === u.id || t.createdBy === u.id;
    return Boolean(t.patientId) || t.createdBy === u.id;
  },
  "care-task:create": (u, _t, { patient } = {}) => !patient || clinical(u, patient),
  "care-task:update": (u, t, { patient } = {}) => {
    if (t.patientId && !clinical(u, patient)) return false;
    if (u.role === "nurse") return department(u, t) || t.assigneeId === u.id;
    return Boolean(t.patientId) || t.createdBy === u.id;
  },

  "shift:read": (u, s) => s.staffId === u.id || sameFacility(u, s) || systemAdmin(u),
  "shift:manage": (u, s) => facility(u, s),
  // Handover notes are PHI: only on doctor and nurse shifts, by their owner.
  "shift:handover": (u, s) => s.staffId === u.id && ["doctor", "nurse"].includes(s.staffRole),

  "notification:read": (u, n) => n.userId === u.id,
  "notification:update": (u, n) => n.userId === u.id,

  "conversation:read": (u, c, { patient } = {}) => conversationVisible(u, c, patient),
  "message:create": (u, c, { patient } = {}) => conversationVisible(u, c, patient),
  "channel:manage": (u, c) => facility(u, c),

  "user:read": (u, t) => userScope(u, t),
  "user:update": (u, t) => userScope(u, t),

  "department:read": (u, d) => systemAdmin(u) || sameFacility(u, d),
  "department:manage": (u, d) => facility(u, d),

  "system-alert:read": (u, a) => facility(u, a) || (u.role === "admin" && a.facilityId == null),
  "system-alert:manage": (u, a) => facility(u, a) || (u.role === "admin" && a.facilityId == null),
};

// Staff in a patient conversation must still have clinical access to the patient.
function conversationVisible(user, conversation, patient) {
  if (!participant(user, conversation)) return false;
  if (conversation.type === "patient" && user.role !== "patient") return clinical(user, patient);
  if (conversation.type === "patient") return patientAccess(user, patient) === "self";
  return true;
}

// The read permission that decides visibility for each resource type.
const READ_OF = {
  patient: "patient:read",
  vitals: "vitals:read",
  appointment: "appointment:read",
  prescription: "prescription:read",
  "medication-administration": "medication-administration:read",
  "medical-record": "medical-record:read",
  "care-task": "care-task:read",
  shift: "shift:read",
  notification: "notification:read",
  conversation: "conversation:read",
  message: "conversation:read",
  channel: "conversation:read",
  user: "user:read",
  department: "department:read",
  "system-alert": "system-alert:read",
};

const typeOf = (permission) => permission.split(":")[0];

// Matrix + relationship rule.
export function can(user, permission, resource, context = {}) {
  if (!hasPermission(user, permission)) return false;
  const rule = RULES[permission];
  return rule ? Boolean(rule(user, resource, context)) : true;
}

// Throws the problem from §3.5 when the caller may not perform `permission` on `resource`.
export function authorize(user, permission, resource, context = {}, { what } = {}) {
  if (!hasPermission(user, permission)) throw forbidden();
  const type = typeOf(permission);
  const readPermission = READ_OF[type];
  const readRule = readPermission && RULES[readPermission];
  const label = what ?? type.replace(/-/g, " ");
  if (!resource) throw notFound(label);
  // Creates have no resource yet: visibility comes from the parent (e.g. the loaded patient).
  const creating = permission.endsWith(":create");
  if (!creating && readRule && !readRule(user, resource, context)) throw notFound(label);
  if (!can(user, permission, resource, context)) throw forbidden();
  return resource;
}
