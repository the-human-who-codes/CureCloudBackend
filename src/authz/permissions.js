// Role → permission matrix (docs/domain-model.md §3.2). Deny by default: a permission that is not
// listed for a role is denied. Relationship rules live in rules.js.

const EVERYONE = [
  "profile:read",
  "profile:update",
  "preferences:read",
  "preferences:update",
  "dashboard:read",
  "practitioner:list",
  "practitioner:read-busy",
  "facility:read",
  "patient:read",
  "patient:update",
  "appointment:read",
  "appointment:create",
  "appointment:update",
  "notification:read",
  "notification:update",
  "conversation:read",
  "conversation:create",
  "message:create",
  "system-settings:read",
];

const CLINICAL = [
  "department:read",
  "patient:list",
  "patient:create",
  "patient:admit",
  "vitals:read",
  "vitals:create",
  "vitals:retract",
  "prescription:read",
  "medication-administration:read",
  "medication-administration:create",
  "medication-administration:retract",
  "medication-schedule:read",
  "medical-record:read",
  "medical-record:create",
  "medical-record:update",
  "care-task:read",
  "care-task:create",
  "care-task:update",
  "shift:read",
  "shift:handover",
  "report:read",
];

export const ROLE_PERMISSIONS = Object.freeze({
  patient: Object.freeze([
    ...EVERYONE,
    "patient:read-identifier",
    "vitals:read",
    "prescription:read",
    "prescription:request-refill",
    "medication-administration:read",
    "medical-record:read",
  ]),
  nurse: Object.freeze([...EVERYONE, ...CLINICAL]),
  doctor: Object.freeze([
    ...EVERYONE,
    ...CLINICAL,
    "patient:manage-care-team",
    "prescription:create",
    "prescription:update",
  ]),
  admin: Object.freeze([
    ...EVERYONE,
    "user:list",
    "user:read",
    "user:update",
    "department:read",
    "department:manage",
    "patient:list",
    "patient:create",
    "patient:read-identifier",
    "patient:manage-care-team",
    "patient:admit",
    "shift:read",
    "shift:manage",
    "channel:manage",
    "system-settings:update",
    "system-alert:read",
    "system-alert:manage",
    "report:read",
  ]),
});

const SETS = Object.fromEntries(Object.entries(ROLE_PERMISSIONS).map(([role, perms]) => [role, new Set(perms)]));

// Matrix only: "can this role ever do X?"
export function hasPermission(user, permission) {
  return Boolean(user && SETS[user.role]?.has(permission));
}

export function permissionsFor(user) {
  if (!user || user.status !== "active") return [];
  return [...(ROLE_PERMISSIONS[user.role] ?? [])].sort();
}
