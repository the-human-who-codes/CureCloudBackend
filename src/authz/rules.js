// Relationship and attribute rules (docs/domain-model.md §3.3). Pure functions over (user, resource):
// no Firestore access, so they are unit-tested without emulators (test/policy.test.js).

const STAFF = new Set(["doctor", "nurse"]);
const present = (v) => v !== null && v !== undefined;

export const isStaff = (user) => STAFF.has(user?.role);

export const systemAdmin = (user) => user?.role === "admin" && !present(user.facilityId);

export const self = (user, resource) =>
  Boolean(user && resource) && (resource.userId === user.id || resource.id === user.id) && present(user.id);

export const careTeam = (user, patient) => Boolean(patient?.careTeam?.includes(user.id));

export const ward = (user, patient) =>
  user?.role === "nurse" &&
  present(user.departmentId) &&
  present(patient?.admission?.departmentId) &&
  patient.admission.departmentId === user.departmentId;

export const clinical = (user, patient) => isStaff(user) && Boolean(patient) && (careTeam(user, patient) || ward(user, patient));

// A null resource.facilityId passes only for system admins.
export const facility = (user, resource) =>
  user?.role === "admin" &&
  (systemAdmin(user) || (present(user.facilityId) && resource?.facilityId === user.facilityId));

export const sameFacility = (user, resource) => present(user?.facilityId) && resource?.facilityId === user.facilityId;

export const department = (user, resource) =>
  present(user?.departmentId) && resource?.departmentId === user.departmentId;

export const userScope = (user, target) =>
  user?.role === "admin" &&
  Boolean(target) &&
  (systemAdmin(user) ||
    (facility(user, target) && target.role !== "patient") ||
    (STAFF.has(target.role) && target.status === "pending" && !present(target.facilityId)));

// Patient access level: "self" | "clinical" | "administrative" | null (surfaced as 404).
export function patientAccess(user, patient) {
  if (!user || !patient) return null;
  if (user.role === "patient") return patient.userId === user.id ? "self" : null;
  if (isStaff(user)) return clinical(user, patient) ? "clinical" : null;
  if (user.role === "admin") return facility(user, patient) ? "administrative" : null;
  return null;
}

// Conversation membership. Channels have implicit membership; patients never see channels.
export function participant(user, conversation) {
  if (!user || !conversation) return false;
  if (conversation.type === "channel") {
    return (
      ["doctor", "nurse", "admin"].includes(user.role) &&
      (systemAdmin(user) || sameFacility(user, conversation)) &&
      (!present(conversation.departmentId) || department(user, conversation) || user.role === "admin")
    );
  }
  return Boolean(conversation.participantIds?.includes(user.id));
}

// The resource was created or performed by the user (entity-specific author fields).
export const author = (user, resource) =>
  Boolean(resource) &&
  [resource.createdBy, resource.authorId, resource.performerId, resource.prescriberId].some((v) => v === user.id);
