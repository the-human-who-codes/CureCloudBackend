// Pure unit tests of the AuthZ module (docs/domain-model.md §3): the matrix, relationship rules,
// redaction, writable fields and the scoped builders' actor-filter rules. No emulator needed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ROLE_PERMISSIONS,
  authorize,
  can,
  clinical,
  department,
  facility,
  hasPermission,
  participant,
  patientAccess,
  permissionsFor,
  redact,
  sameFacility,
  scoped,
  systemAdmin,
  userScope,
  writableFields,
} from "../src/authz/index.js";

const patientUser = { id: "pu", role: "patient", status: "active", facilityId: null };
const doctor = { id: "d1", role: "doctor", status: "active", facilityId: "f1", departmentId: "dep1" };
const nurse = { id: "n1", role: "nurse", status: "active", facilityId: "f1", departmentId: "ward1" };
const otherNurse = { id: "n2", role: "nurse", status: "active", facilityId: "f1", departmentId: "ward2" };
const facilityAdmin = { id: "a1", role: "admin", status: "active", facilityId: "f1" };
const otherAdmin = { id: "a2", role: "admin", status: "active", facilityId: "f2" };
const sysAdmin = { id: "s1", role: "admin", status: "active", facilityId: null };

const patient = {
  id: "p1",
  userId: "pu",
  facilityId: "f1",
  name: "Thandi",
  careTeam: ["d1"],
  admission: { departmentId: "ward1", room: "12" },
  identifier: { type: "za-id", value: "9005045800083" },
  allergies: [{ substance: "Penicillin", severity: "severe" }],
  noKnownAllergies: false,
  chronicConditions: [],
  bloodType: "O+",
  acuity: "high",
  latestVitals: null,
  nameLower: "thandi",
  conditionCategories: [],
  schemaVersion: 2,
  legacy: { room: "12" },
  admitted: true,
};
const selfRegistered = { ...patient, id: "p2", userId: "pu2", facilityId: null, careTeam: [], admission: null };

describe("role permission matrix (§3.2)", () => {
  // The full matrix, written out from the contract table so a change to either is caught.
  const MATRIX = {
    "profile:read": "pnda",
    "profile:update": "pnda",
    "preferences:read": "pnda",
    "preferences:update": "pnda",
    "dashboard:read": "pnda",
    "practitioner:list": "pnda",
    "user:list": "a",
    "user:read": "a",
    "user:update": "a",
    "facility:read": "pnda",
    "department:read": "nda",
    "department:manage": "a",
    "patient:list": "nda",
    "patient:read": "pnda",
    "patient:create": "nda",
    "patient:update": "pnda",
    "patient:read-identifier": "pa",
    "patient:manage-care-team": "da",
    "patient:admit": "nda",
    "vitals:read": "pnd",
    "vitals:create": "nd",
    "vitals:retract": "nd",
    "appointment:read": "pnda",
    "appointment:create": "pnda",
    "appointment:update": "pnda",
    "practitioner:read-busy": "pnda",
    "prescription:read": "pnd",
    "prescription:create": "d",
    "prescription:update": "d",
    "prescription:request-refill": "p",
    "medication-administration:read": "pnd",
    "medication-administration:create": "nd",
    "medication-administration:retract": "nd",
    "medication-schedule:read": "nd",
    "medical-record:read": "pnd",
    "medical-record:create": "nd",
    "medical-record:update": "nd",
    "care-task:read": "nd",
    "care-task:create": "nd",
    "care-task:update": "nd",
    "shift:read": "nda",
    "shift:manage": "a",
    "shift:handover": "nda",
    "notification:read": "pnda",
    "notification:update": "pnda",
    "conversation:read": "pnda",
    "conversation:create": "pnda",
    "message:create": "pnda",
    "channel:manage": "a",
    "system-settings:read": "pnda",
    "system-settings:update": "a",
    "system-alert:read": "a",
    "system-alert:manage": "a",
    "report:read": "nda",
  };
  const roles = { p: patientUser, n: nurse, d: doctor, a: facilityAdmin };

  for (const [permission, allowed] of Object.entries(MATRIX)) {
    test(permission, () => {
      for (const [letter, user] of Object.entries(roles)) {
        assert.equal(hasPermission(user, permission), allowed.includes(letter), `${user.role} ${permission}`);
      }
    });
  }

  test("deny by default", () => {
    assert.equal(hasPermission(doctor, "made:up"), false);
    assert.equal(hasPermission(null, "profile:read"), false);
    assert.equal(hasPermission({ role: "hacker" }, "profile:read"), false);
    // Every granted permission appears in the matrix above (no undocumented grants).
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      for (const p of perms) assert.ok(p in MATRIX, p);
    }
  });

  test("inactive accounts get no permissions in /me", () => {
    assert.deepEqual(permissionsFor({ ...doctor, status: "pending" }), []);
    assert.ok(permissionsFor(doctor).includes("prescription:create"));
  });
});

describe("relationship rules (§3.3)", () => {
  test("facility and department are false when both sides are null", () => {
    assert.equal(facility({ role: "admin", facilityId: "f1" }, { facilityId: null }), false);
    assert.equal(sameFacility({ facilityId: null }, { facilityId: null }), false);
    assert.equal(department({ departmentId: null }, { departmentId: null }), false);
    assert.equal(department({}, {}), false);
  });

  test("a null resource facility passes only for system admins", () => {
    assert.equal(facility(sysAdmin, { facilityId: null }), true);
    assert.equal(facility(facilityAdmin, { facilityId: null }), false);
    assert.equal(facility(facilityAdmin, { facilityId: "f1" }), true);
    assert.equal(facility(otherAdmin, { facilityId: "f1" }), false);
    assert.equal(facility(doctor, { facilityId: "f1" }), false); // staff never pass the admin rule
    assert.equal(systemAdmin(sysAdmin), true);
    assert.equal(systemAdmin(facilityAdmin), false);
    assert.equal(systemAdmin({ role: "doctor", facilityId: null }), false);
  });

  test("patient access levels", () => {
    assert.equal(patientAccess(patientUser, patient), "self");
    assert.equal(patientAccess({ ...patientUser, id: "other" }, patient), null);
    assert.equal(patientAccess(doctor, patient), "clinical"); // care team
    assert.equal(patientAccess(nurse, patient), "clinical"); // ward: admitted to the nurse's department
    assert.equal(patientAccess(otherNurse, patient), null);
    assert.equal(patientAccess({ ...doctor, id: "d2" }, patient), null);
    assert.equal(patientAccess(facilityAdmin, patient), "administrative");
    assert.equal(patientAccess(otherAdmin, patient), null);
    // A self-registered patient who never booked is invisible to every facility admin.
    assert.equal(patientAccess(facilityAdmin, selfRegistered), null);
    assert.equal(patientAccess(sysAdmin, selfRegistered), "administrative");
    // A nurse without a department has no ward access.
    assert.equal(clinical({ ...nurse, departmentId: null }, patient), false);
  });

  test("userScope", () => {
    const pendingUnassigned = { id: "x", role: "doctor", status: "pending", facilityId: null };
    const patientAccount = { id: "y", role: "patient", status: "active", facilityId: null };
    const otherFacilityDoctor = { id: "z", role: "doctor", status: "active", facilityId: "f2" };
    assert.equal(userScope(facilityAdmin, pendingUnassigned), true);
    assert.equal(userScope(facilityAdmin, { ...pendingUnassigned, status: "active" }), false);
    assert.equal(userScope(facilityAdmin, patientAccount), false);
    assert.equal(userScope(facilityAdmin, { ...patientAccount, facilityId: "f1" }), false);
    assert.equal(userScope(facilityAdmin, otherFacilityDoctor), false);
    assert.equal(userScope(facilityAdmin, sysAdmin), false);
    assert.equal(userScope(facilityAdmin, { ...otherAdmin, facilityId: "f1" }), true);
    assert.equal(userScope(sysAdmin, patientAccount), true);
    assert.equal(userScope(doctor, otherFacilityDoctor), false);
  });

  test("a patient never passes facility or channel participant", () => {
    const channel = { type: "channel", facilityId: null, departmentId: null, participantIds: [] };
    assert.equal(facility(patientUser, { facilityId: null }), false);
    assert.equal(participant(patientUser, channel), false);
    assert.equal(participant({ ...patientUser, facilityId: "f1" }, { ...channel, facilityId: "f1" }), false);
    assert.equal(participant(doctor, { ...channel, facilityId: "f1" }), true);
    assert.equal(participant(doctor, { ...channel, facilityId: "f1", departmentId: "other" }), false);
    assert.equal(participant(facilityAdmin, { ...channel, facilityId: "f1", departmentId: "other" }), true);
    assert.equal(participant(doctor, { type: "group", participantIds: ["d1", "x"] }), true);
  });
});

describe("authorize denial semantics (§3.5)", () => {
  const code = (fn) => {
    try {
      fn();
      return "allowed";
    } catch (err) {
      return `${err.status} ${err.code}`;
    }
  };

  test("role lacks the permission → 403, no relationship → 404, visible but not allowed → 403", () => {
    assert.equal(code(() => authorize(patientUser, "prescription:create", {}, { patient })), "403 forbidden");
    assert.equal(code(() => authorize({ ...doctor, id: "d2" }, "patient:read", patient)), "404 not-found");
    const record = { authorId: "d1", status: "preliminary" };
    assert.equal(code(() => authorize(nurse, "medical-record:update", record, { patient })), "403 forbidden");
    assert.equal(code(() => authorize(doctor, "medical-record:update", record, { patient })), "allowed");
    assert.equal(code(() => authorize(doctor, "patient:read", null)), "404 not-found");
  });

  test("patients see only their final and amended records", () => {
    assert.equal(can(patientUser, "medical-record:read", { status: "final" }, { patient }), true);
    assert.equal(can(patientUser, "medical-record:read", { status: "amended" }, { patient }), true);
    assert.equal(can(patientUser, "medical-record:read", { status: "preliminary" }, { patient }), false);
    assert.equal(can(patientUser, "medical-record:read", { status: "entered-in-error" }, { patient }), false);
  });

  test("appointment visibility", () => {
    const appt = { patientUserId: "pu", doctorId: "d9", departmentId: "ward9", facilityId: "f1" };
    assert.equal(can(patientUser, "appointment:read", appt, { patient }), true);
    assert.equal(can(doctor, "appointment:read", appt, { patient }), true); // clinical via care team
    assert.equal(can({ ...doctor, id: "d3" }, "appointment:read", appt, { patient }), false);
    assert.equal(can(otherNurse, "appointment:read", { ...appt, departmentId: "ward2" }, { patient }), true); // department
    assert.equal(can(facilityAdmin, "appointment:read", appt, { patient }), true);
    assert.equal(can(otherAdmin, "appointment:read", appt, { patient }), false);
  });

  test("care task visibility", () => {
    const task = { departmentId: "ward1", assigneeId: null, createdBy: "x", patientId: "p1" };
    assert.equal(can(nurse, "care-task:read", task, { patient }), true);
    assert.equal(can(otherNurse, "care-task:read", task, { patient }), false);
    assert.equal(can(otherNurse, "care-task:read", { ...task, assigneeId: "n2" }, { patient }), true);
    assert.equal(can(doctor, "care-task:read", task, { patient }), true);
    assert.equal(can({ ...doctor, id: "d3" }, "care-task:read", task, { patient }), false);
  });
});

describe("field-level redaction (§3.4)", () => {
  test("patient fields per access level", () => {
    const self = redact(patientUser, "patient", patient);
    assert.ok(self.identifier && self.allergies && self.acuity);
    const clin = redact(doctor, "patient", patient);
    assert.equal(clin.identifier, undefined);
    assert.equal(clin.acuity, "high");
    const admin = redact(facilityAdmin, "patient", patient);
    assert.ok(admin.identifier);
    assert.ok(admin.admission);
    for (const f of ["allergies", "noKnownAllergies", "chronicConditions", "bloodType", "latestVitals", "acuity"]) {
      assert.equal(admin[f], undefined, f);
    }
    for (const hidden of ["nameLower", "conditionCategories", "schemaVersion", "legacy", "admitted"]) {
      assert.equal(self[hidden], undefined, hidden);
    }
  });

  test("appointment reason is self and clinical only", () => {
    const appt = { patientUserId: "pu", doctorId: "d1", departmentId: "ward2", reason: "Chest pain", cancellationReason: "x" };
    assert.equal(redact(patientUser, "appointment", appt, { patient }).reason, "Chest pain");
    assert.equal(redact(doctor, "appointment", appt, { patient }).reason, "Chest pain");
    assert.equal(redact(facilityAdmin, "appointment", appt, { patient }).reason, undefined);
    // A nurse who sees the appointment only through department scope does not see the reason.
    assert.equal(redact(otherNurse, "appointment", appt, { patient }).reason, undefined);
    assert.equal(redact(otherNurse, "appointment", appt, { patient }).cancellationReason, undefined);
  });

  test("handover notes: owner and same-department clinicians, never admins", () => {
    const shift = { staffId: "n1", departmentId: "ward1", handoverNote: "Bed 4 needs obs" };
    assert.equal(redact(nurse, "shift", shift).handoverNote, "Bed 4 needs obs");
    assert.equal(redact({ ...doctor, departmentId: "ward1" }, "shift", shift).handoverNote, "Bed 4 needs obs");
    assert.equal(redact(otherNurse, "shift", shift).handoverNote, undefined);
    assert.equal(redact({ ...facilityAdmin, departmentId: "ward1" }, "shift", shift).handoverNote, undefined);
    assert.equal(redact({ ...facilityAdmin, id: "n1" }, "shift", shift).handoverNote, "Bed 4 needs obs");
  });

  test("practitioner email is omitted for patients; lastSignInAt is admin only", () => {
    const summary = { id: "d1", email: "d@x.test" };
    assert.equal(redact(patientUser, "practitionerSummary", summary).email, undefined);
    assert.equal(redact(nurse, "practitionerSummary", summary).email, "d@x.test");
    const user = { id: "d1", role: "doctor", facilityId: "f1", lastSignInAt: "x", phone: "+27", identifier: {} };
    assert.equal(redact(doctor, "user", user).lastSignInAt, undefined);
    assert.equal(redact(doctor, "user", user).phone, "+27");
    assert.equal(redact(facilityAdmin, "user", user).lastSignInAt, "x");
    assert.equal(redact(otherAdmin, "user", user).identifier, undefined);
  });

  test("conversation read markers are replaced by unreadCount", () => {
    const out = redact(doctor, "conversation", { id: "c", lastReadAt: { d1: 1 } }, { unreadCount: 3 });
    assert.equal(out.lastReadAt, undefined);
    assert.equal(out.unreadCount, 3);
  });
});

describe("writable patient fields (§3.4)", () => {
  test("per access level", () => {
    const self = writableFields(patientUser, "patient", patient);
    assert.ok(self.has("phone") && self.has("emergencyContact"));
    assert.ok(!self.has("acuity") && !self.has("identifier")); // identifier already set
    assert.ok(writableFields(patientUser, "patient", { ...patient, identifier: null }).has("identifier"));
    const nurseFields = writableFields(nurse, "patient", patient);
    assert.ok(nurseFields.has("allergies") && !nurseFields.has("status") && !nurseFields.has("identifier"));
    assert.ok(writableFields(doctor, "patient", patient).has("status"));
    const admin = writableFields(facilityAdmin, "patient", patient);
    assert.ok(admin.has("identifier") && admin.has("status") && !admin.has("acuity") && !admin.has("facilityId"));
    assert.ok(writableFields(sysAdmin, "patient", patient).has("facilityId"));
    assert.equal(writableFields({ ...doctor, id: "x" }, "patient", patient).size, 0);
  });
});

describe("scoped builders and actor filters (§3.3)", () => {
  const code = (fn) => {
    try {
      fn();
      return "ok";
    } catch (err) {
      return `${err.status}`;
    }
  };

  test("doctors may only filter by their own prescriber/author ID unless patient-scoped", () => {
    assert.equal(code(() => scoped.prescriptions(doctor, { prescriberId: "d2" })), "403");
    assert.equal(code(() => scoped.prescriptions(doctor, { prescriberId: "me" })), "ok");
    assert.equal(code(() => scoped.prescriptions(doctor, { prescriberId: "d2" }, { patientId: "p1" })), "ok");
    assert.equal(code(() => scoped.medicalRecords(nurse, { authorId: "d2" })), "403");
    assert.equal(code(() => scoped.medicationAdministrations(nurse, { performerId: "n2" })), "403");
    assert.equal(code(() => scoped.medicationAdministrations(nurse, { performerId: "n2" }, { patientId: "p1" })), "ok");
    assert.equal(code(() => scoped.appointments(doctor, { doctorId: "d2" })), "403");
    assert.equal(code(() => scoped.appointments(nurse, { departmentId: "ward2" })), "403");
  });

  test("lists are pinned to the caller's scope", () => {
    const s = scoped.prescriptions(doctor, {});
    assert.deepEqual(s.where[0], ["prescriberId", "==", "d1"]);
    const p = scoped.patients(nurse, {});
    assert.equal(p.or.length, 2);
    assert.deepEqual(scoped.patients(facilityAdmin, {}).where, [["facilityId", "==", "f1"]]);
    assert.equal(code(() => scoped.patients(facilityAdmin, { facilityId: "f2" })), "403");
    assert.equal(code(() => scoped.patients(facilityAdmin, { acuity: "critical" })), "403");
    assert.equal(code(() => scoped.users(facilityAdmin, { role: ["patient"] })), "403");
    assert.equal(code(() => scoped.users(facilityAdmin, { q: "th", departmentId: "dep1" })), "400");
    assert.equal(code(() => scoped.conversations(patientUser, { type: "channel" })), "403");
    // Default list results exclude entered-in-error.
    assert.ok(!scoped.prescriptions(doctor, {}).where.find(([f]) => f === "status")[2].includes("entered-in-error"));
    assert.deepEqual(scoped.medicalRecords(patientUser, {}, { patientId: "p1" }).where.at(-1), ["status", "in", ["final", "amended"]]);
  });
});
