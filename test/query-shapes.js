// Enumerates every query shape the API can issue: each scoped builder × each role × each allowed
// filter combination, plus the fixed internal queries. Used by test/indexes.test.js.
import { dashboardSpecs, hasPermission, queries, queryShapes, reportSpecs, scoped } from "../src/authz/index.js";

const now = new Date("2026-10-12T08:00:00Z");
const later = new Date("2026-10-19T08:00:00Z");

export const USERS = {
  patient: { id: "p1", role: "patient", status: "active", facilityId: null },
  doctor: { id: "d1", role: "doctor", status: "active", facilityId: "f1", departmentId: "dep1" },
  nurse: { id: "n1", role: "nurse", status: "active", facilityId: "f1", departmentId: "dep1" },
  nurseNoDept: { id: "n2", role: "nurse", status: "active", facilityId: "f1", departmentId: null },
  facilityAdmin: { id: "a1", role: "admin", status: "active", facilityId: "f1" },
  systemAdmin: { id: "s1", role: "admin", status: "active", facilityId: null },
};

// All subsets of the given optional filters, merged into a base.
function combos(options, base = {}) {
  const keys = Object.keys(options);
  const out = [];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const f = { ...base };
    keys.forEach((k, i) => {
      if (mask & (1 << i)) f[k] = options[k];
    });
    out.push(f);
  }
  return out;
}

// Calls a builder, skipping combinations it rejects (those return 400/403 and issue no query).
function attempt(label, fn, out, user, permission) {
  if (user && permission && !hasPermission(user, permission)) return;
  try {
    const s = fn();
    if (s) out.push(...queryShapes(s).map((shape) => ({ ...shape, label })));
  } catch (err) {
    if (!err.code) throw err; // only HttpProblems are expected
  }
}

export function allShapes() {
  const out = [];
  for (const [who, user] of Object.entries(USERS)) {
    for (const f of combos({ q: "th", acuity: "critical", admitted: true, facilityId: "f1" })) {
      attempt(`patients ${who} ${JSON.stringify(f)}`, () => scoped.patients(user, f), out, user, "patient:list");
    }
    const apptOptions = { doctorId: "me", departmentId: "dep1", status: ["pending", "confirmed"], from: now, to: later };
    for (const ctx of [{}, { patientId: "x" }, { doctorId: "d9" }, { departmentId: "dep1" }]) {
      for (const f of combos(apptOptions)) {
        if (ctx.doctorId) f.doctorId = "d9";
        attempt(`appointments ${who} ${JSON.stringify({ f, ctx })}`, () => scoped.appointments(user, f, ctx), out, user, "appointment:read");
      }
    }
    for (const ctx of [{}, { patientId: "x" }]) {
      for (const f of combos({ prescriberId: "me", status: ["active"], category: "inpatient" })) {
        attempt(`prescriptions ${who}`, () => scoped.prescriptions(user, f, ctx), out, user, "prescription:read");
        attempt(`prescriptions ${who} multi-status`, () => scoped.prescriptions(user, { ...f, status: ["active", "on-hold"] }, ctx), out, user, "prescription:read");
      }
      for (const f of combos({ authorId: "me", category: "lab-result", status: ["final"] })) {
        attempt(`medicalRecords ${who}`, () => scoped.medicalRecords(user, f, ctx), out, user, "medical-record:read");
      }
    }
    for (const ctx of [{}, { patientId: "x" }, { prescriptionId: "rx" }, { patientId: "x", prescriptionId: "rx" }]) {
      for (const f of combos({ performerId: "me", status: ["completed"], from: now, to: later })) {
        attempt(`administrations ${who}`, () => scoped.medicationAdministrations(user, f, ctx), out, user, "medication-administration:read");
      }
    }
    for (const ctx of [{}, { patientId: "x" }, { assigneeId: "n9" }]) {
      for (const assigneeId of [undefined, "me", "unassigned", "n9"]) {
        for (const f of combos({ departmentId: "dep1", status: ["open"], priority: "high", dueBefore: later })) {
          attempt(`careTasks ${who}`, () => scoped.careTasks(user, { ...f, assigneeId }, ctx), out, user, "care-task:read");
        }
      }
    }
    for (const f of combos({ completedAfter: now })) {
      attempt(`careTasks completed ${who}`, () => scoped.careTasks(user, { ...f, completedBy: "me" }), out, user, "care-task:read");
    }
    for (const [f, ctx] of [
      [{}, {}],
      [{ staffId: "me" }, {}],
      [{ staffId: "x9" }, { staffId: "x9" }],
      [{ departmentId: "dep1" }, { departmentId: "dep1" }],
      [{ facilityId: "f1" }, {}],
    ]) {
      attempt(`shifts ${who}`, () => scoped.shifts(user, { ...f, from: now, to: later }, ctx), out, user, "shift:read");
    }
    for (const type of [undefined, "direct", "group", "channel", "patient"]) {
      attempt(`conversations ${who} ${type}`, () => scoped.conversations(user, { type }), out, user, "conversation:read");
    }
    const userOptions = { role: ["doctor"], status: "pending", facilityId: "f1", departmentId: "dep1", q: "th" };
    for (const f of combos(userOptions)) {
      attempt(`users ${who} ${JSON.stringify(f)}`, () => scoped.users(user, f, { departmentId: "dep1" }), out, user, "user:list");
      attempt(`users ${who} multi-role`, () => scoped.users(user, { ...f, role: ["doctor", "nurse"] }, { departmentId: "dep1" }), out, user, "user:list");
      attempt(`users ${who} active`, () => scoped.users(user, { ...f, status: "active" }, { departmentId: "dep1" }), out, user, "user:list");
    }
    for (const f of combos({ role: "doctor", facilityId: "f1", departmentId: "dep1", q: "th" })) {
      attempt(`practitioners ${who}`, () => scoped.practitioners(user, f), out, user, "practitioner:list");
    }
    for (const f of combos({ unread: true })) attempt(`notifications ${who}`, () => scoped.notifications(user, f), out, user, "notification:read");
    for (const f of combos({ status: ["active"], severity: ["critical", "warning"] })) {
      attempt(`systemAlerts ${who}`, () => scoped.systemAlerts(user, f), out, user, "system-alert:read");
    }
    for (const f of combos({ status: "active" })) attempt(`facilities ${who}`, () => scoped.facilities(user, f), out, user, "facility:read");
    for (const f of combos({ facilityId: "f1", status: "active" })) {
      attempt(`departments ${who}`, () => scoped.departments(user, f), out, user, "department:read");
    }
    for (const f of combos({ status: ["entered-in-error"] })) attempt(`vitals ${who}`, () => scoped.vitals(user, "x", f), out, user, "vitals:read");
    attempt(`messages ${who}`, () => scoped.messages(user, "c"), out, user, "conversation:read");

    const ctx = { ownPatientId: "p1", startOfDay: now, endOfDay: later };
    for (const [name, s] of Object.entries(dashboardSpecs(user, now, ctx))) {
      attempt(`dashboard ${who} ${name}`, () => s, out);
    }
    for (const f of combos({ facilityId: "f1", departmentId: "dep1" })) {
      if (!hasPermission(user, "report:read")) break;
      try {
        const specs = reportSpecs(user, { from: now, to: later, ...f });
        for (const key of ["patients", "appointments", "prescriptions", "departments"]) {
          if (specs[key]) attempt(`report ${who} ${key}`, () => specs[key], out);
        }
      } catch (err) {
        if (!err.code) throw err;
      }
    }
  }

  const fixed = {
    slotLocks: queries.slotLocks("d1", now, later),
    staffShifts: queries.staffShifts("d1", now, later),
    departmentShifts: queries.departmentShifts("dep1", now, later),
    facilityShifts: queries.facilityShifts("f1", now, later),
    previousShifts: queries.previousShifts("dep1", now),
    recentFinalVitals: queries.recentFinalVitals("x"),
    completedAdministrations: queries.completedAdministrations("rx"),
    inpatientPrescriptions: queries.inpatientPrescriptions(["a", "b"]),
    openSignupAlerts: queries.openSignupAlerts("u"),
    activeSystemAdmins: queries.activeSystemAdmins(),
    departmentByName: queries.departmentByName("f1", "cardiology"),
    unreadMessages: queries.unreadMessages("c", now),
    unreadNotifications: queries.unreadNotifications("u"),
    ownPatient: queries.ownPatient("u"),
    departmentStaff: queries.departmentStaff("dep1", "doctor"),
    departmentAdmitted: queries.departmentAdmitted("dep1"),
    departmentAppointments: queries.departmentAppointments("dep1", now, later),
  };
  for (const [name, s] of Object.entries(fixed)) attempt(`queries.${name}`, () => s, out);
  return out;
}
