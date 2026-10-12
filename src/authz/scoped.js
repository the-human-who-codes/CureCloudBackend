// Scoped query builders (docs/domain-model.md §3.6). Routes always list through these, never through
// raw collection queries, so every list is pinned to what the caller may see. Builders are pure:
// anything that needs a read (is this patientId clinical? is that doctor in my facility?) is checked
// by the route first and passed in `ctx`.
import { forbidden, badRequest } from "../lib/problem.js";
import { participant, systemAdmin, userScope } from "./rules.js";
import { eq, prefix, spec } from "./query.js";

const ts = "timestamp";
const str = "string";
const DAY = 86400e3;

const LIVE_PRESCRIPTION = ["active", "on-hold", "completed", "stopped"];
const LIVE_RECORD = ["preliminary", "final", "amended"];
const PATIENT_RECORD = ["final", "amended"];
const LIVE_ADMINISTRATION = ["completed", "not-done"];
const OPEN_TASK = ["open", "in-progress"];

// Resolves an actor filter: "me" or the caller's own ID → the caller's ID, anything else → 403
// unless the query is already patient-scoped (ctx.patientScoped), where it only narrows.
function actor(user, value, { patientScoped = false } = {}) {
  if (value === undefined) return undefined;
  if (value === "me" || value === user.id) return user.id;
  if (patientScoped) return value;
  throw forbidden("You can only filter by your own ID here");
}

const range = (field, from, to) => [from && [field, ">=", from], to && [field, "<", to]];

export const scoped = {
  // careTeam (doctor) / Filter.or(careTeam, ward) (nurse) / facility (admin), sorted by nameLower.
  patients(user, { q, acuity, admitted, facilityId } = {}) {
    if (admitted !== undefined && (q || acuity)) throw badRequest("admitted cannot be combined with q or acuity");
    if (acuity && user.role === "admin") throw forbidden("acuity is clinical data");
    const where = [];
    let or;
    if (user.role === "doctor") where.push(["careTeam", "array-contains", user.id]);
    else if (user.role === "nurse") {
      if (user.departmentId) {
        or = [[["careTeam", "array-contains", user.id]], [["admission.departmentId", "==", user.departmentId]]];
      } else where.push(["careTeam", "array-contains", user.id]);
    } else if (user.role === "admin") {
      if (!systemAdmin(user) && facilityId && facilityId !== user.facilityId) throw forbidden();
      const f = systemAdmin(user) ? facilityId : user.facilityId;
      if (f) where.push(["facilityId", "==", f]);
    } else throw forbidden();
    if (facilityId && user.role !== "admin") throw forbidden("facilityId is for administrators");
    if (q) where.push(...prefix("nameLower", q));
    if (acuity) where.push(["acuity", "==", acuity]);
    if (admitted !== undefined) where.push(["admitted", "==", admitted]);
    return spec("patients", { where, or, orderBy: [["nameLower", "asc", str]] });
  },

  // ctx.patientId: an authorized patient (own for patients); ctx.doctorId / ctx.departmentId:
  // values the route verified for admins.
  appointments(user, { doctorId, departmentId, status, from, to } = {}, ctx = {}) {
    const where = [];
    let filter;
    if (ctx.patientId) {
      where.push(["patientId", "==", ctx.patientId]);
      const d = actor(user, doctorId, { patientScoped: user.role !== "patient" });
      if (d) where.push(["doctorId", "==", d]);
      if (departmentId) throw badRequest("departmentId cannot be combined with patientId");
      if (user.role === "admin" && !systemAdmin(user)) filter = (a) => a.facilityId === user.facilityId;
    } else if (user.role === "patient") {
      throw forbidden();
    } else if (user.role === "doctor") {
      if (departmentId) throw forbidden("doctors list their own schedule");
      where.push(["doctorId", "==", actor(user, doctorId ?? "me")]);
    } else if (user.role === "nurse") {
      if (doctorId !== undefined) actor(user, doctorId);
      if (departmentId && departmentId !== user.departmentId) throw forbidden("You can only list your own department");
      if (!user.departmentId) throw forbidden("patientId is required");
      where.push(["departmentId", "==", user.departmentId]);
    } else if (user.role === "admin") {
      if (doctorId) {
        if (ctx.doctorId !== doctorId) throw forbidden();
        where.push(["doctorId", "==", doctorId]);
      } else if (departmentId) {
        if (ctx.departmentId !== departmentId) throw forbidden();
        where.push(["departmentId", "==", departmentId]);
      } else if (!systemAdmin(user)) where.push(["facilityId", "==", user.facilityId]);
    }
    if (status) where.push(eq("status", status));
    where.push(...range("start", from, to));
    return spec("appointments", { where, orderBy: [["start", "asc", ts]], filter });
  },

  prescriptions(user, { prescriberId, status, category } = {}, ctx = {}) {
    if (user.role === "patient" && status?.includes("entered-in-error")) throw forbidden();
    const where = [];
    if (ctx.patientId) {
      where.push(["patientId", "==", ctx.patientId]);
      const p = actor(user, prescriberId, { patientScoped: user.role !== "patient" });
      if (p) where.push(["prescriberId", "==", p]);
    } else if (user.role === "patient") throw forbidden();
    else where.push(["prescriberId", "==", actor(user, prescriberId ?? "me")]);
    where.push(eq("status", status ?? LIVE_PRESCRIPTION));
    if (category) where.push(["category", "==", category]);
    return spec("prescriptions", { where, orderBy: [["createdAt", "desc", ts]] });
  },

  medicalRecords(user, { authorId, category, status } = {}, ctx = {}) {
    const where = [];
    let statuses = status ?? (user.role === "patient" ? PATIENT_RECORD : LIVE_RECORD);
    if (user.role === "patient") {
      statuses = statuses.filter((s) => PATIENT_RECORD.includes(s));
      if (!statuses.length) throw forbidden();
    }
    if (ctx.patientId) {
      where.push(["patientId", "==", ctx.patientId]);
      const a = actor(user, authorId, { patientScoped: user.role !== "patient" });
      if (a) where.push(["authorId", "==", a]);
    } else if (user.role === "patient") throw forbidden();
    else where.push(["authorId", "==", actor(user, authorId ?? "me")]);
    where.push(eq("status", statuses));
    if (category) where.push(["category", "==", category]);
    return spec("medicalRecords", { where, orderBy: [["effectiveAt", "desc", ts]] });
  },

  // At least one of ctx.patientId, ctx.prescriptionId or performerId.
  medicationAdministrations(user, { performerId, status, from, to } = {}, ctx = {}) {
    const where = [];
    const patientScoped = Boolean(ctx.patientId || ctx.prescriptionId) && user.role !== "patient";
    if (ctx.patientId) where.push(["patientId", "==", ctx.patientId]);
    if (ctx.prescriptionId) where.push(["prescriptionId", "==", ctx.prescriptionId]);
    if (user.role === "patient" && !ctx.patientId) throw forbidden();
    const p = actor(user, performerId, { patientScoped });
    if (p) where.push(["performerId", "==", p]);
    if (!where.length) throw badRequest("One of patientId, prescriptionId or performerId is required");
    where.push(eq("status", status ?? LIVE_ADMINISTRATION));
    where.push(...range("occurredAt", from, to));
    return spec("medicationAdministrations", { where, orderBy: [["occurredAt", "desc", ts]] });
  },

  // ctx.patientId: a clinical patient; ctx.assigneeId: a nurse the route verified is in the
  // caller's department.
  careTasks(user, f = {}, ctx = {}) {
    if (f.completedBy) {
      const extra = ["assigneeId", "departmentId", "patientId", "status", "priority", "dueBefore"].filter(
        (k) => f[k] !== undefined,
      );
      if (extra.length) throw badRequest(`completedBy cannot be combined with ${extra[0]}`);
      return spec("careTasks", {
        where: [["completedBy", "==", user.id], f.completedAfter && ["completedAt", ">=", f.completedAfter]],
        orderBy: [["completedAt", "desc", ts]],
      });
    }
    const where = [];
    const dept = user.role === "nurse" ? user.departmentId : null;
    if (f.departmentId && f.departmentId !== user.departmentId) throw forbidden("You can only list your own department");
    if (f.departmentId && ctx.patientId) throw badRequest("departmentId cannot be combined with patientId");
    if (ctx.patientId) where.push(["patientId", "==", ctx.patientId]);
    const assignee = f.assigneeId;
    if (assignee === "me" || assignee === user.id) where.push(["assigneeId", "==", user.id]);
    else if (assignee) {
      // "unassigned" or a colleague: department scope (nurses) or patient scope (anyone clinical).
      if (!ctx.patientId) {
        if (!dept) throw forbidden("Only nurses in a department can list other assignees");
        if (assignee !== "unassigned" && ctx.assigneeId !== assignee) throw forbidden();
        where.push(["departmentId", "==", dept]);
      }
      where.push(["assigneeId", "==", assignee === "unassigned" ? null : assignee]);
    }
    if (f.departmentId && !where.some(([field]) => field === "departmentId")) {
      where.push(["departmentId", "==", f.departmentId]);
    }
    if (!where.length) {
      if (dept) where.push(["departmentId", "==", dept]);
      else if (user.role === "nurse") where.push(["assigneeId", "==", user.id]);
      else where.push(["createdBy", "==", user.id]);
    }
    where.push(eq("status", f.status ?? OPEN_TASK));
    if (f.priority) where.push(["priority", "==", f.priority]);
    if (f.dueBefore) where.push(["dueAt", "<", f.dueBefore]);
    return spec("careTasks", { where, orderBy: [["dueAt", "asc", ts]] });
  },

  // Shifts are at most 24h long, so start ∈ [from − 24h, to) plus end > from in memory is exact.
  // ctx.staffId / ctx.departmentId: values the route verified are in the caller's facility.
  shifts(user, { staffId, departmentId, facilityId, from, to }, ctx = {}) {
    const where = [];
    if (staffId) {
      const s = staffId === "me" ? user.id : staffId;
      if (s !== user.id && ctx.staffId !== s) throw forbidden();
      where.push(["staffId", "==", s]);
    } else if (departmentId) {
      if (ctx.departmentId !== departmentId) throw forbidden();
      where.push(["departmentId", "==", departmentId]);
    } else if (systemAdmin(user)) {
      if (facilityId) where.push(["facilityId", "==", facilityId]);
    } else if (user.facilityId) {
      if (facilityId && facilityId !== user.facilityId) throw forbidden();
      where.push(["facilityId", "==", user.facilityId]);
    } else where.push(["staffId", "==", user.id]);
    where.push(["start", ">=", new Date(from.getTime() - DAY)], ["start", "<", to]);
    return spec("shifts", {
      where,
      orderBy: [["start", "asc", ts]],
      filter: (s) => toMillis(s.end) > from.getTime(),
    });
  },

  conversations(user, { type } = {}) {
    const mine = ["participantIds", "array-contains", user.id];
    const channels = systemAdmin(user)
      ? [["type", "==", "channel"]]
      : user.facilityId
        ? [
            ["facilityId", "==", user.facilityId],
            ["type", "==", "channel"],
          ]
        : null;
    const visible = (c) => participant(user, c) && !(c.type === "channel" && c.status === "archived");
    const orderBy = [["lastMessageAt", "desc", ts]];
    if (user.role === "patient") {
      if (type && type !== "patient") throw forbidden("Patients only have patient conversations");
      return spec("conversations", { where: [mine], orderBy, filter: visible });
    }
    if (type === "channel") {
      if (!channels) throw forbidden("You are not assigned to a facility");
      return spec("conversations", { where: channels, orderBy, filter: visible });
    }
    if (type) return spec("conversations", { where: [mine, ["type", "==", type]], orderBy, filter: visible });
    if (!channels) return spec("conversations", { where: [mine], orderBy, filter: visible });
    return spec("conversations", { or: [[mine], channels], orderBy, filter: visible });
  },

  // userScope: system admin all; facility admin own-facility staff and admins plus pending
  // unassigned staff, never patient accounts. ctx.departmentId: verified to be in the facility.
  users(user, { role, status, facilityId, departmentId, q } = {}, ctx = {}) {
    if (q && (facilityId || departmentId)) throw badRequest("q can only be combined with role and status");
    const filters = [role && eq("role", role), status && ["status", "==", status]];
    if (q) filters.push(...prefix("nameLower", q));
    const orderBy = [["nameLower", "asc", str]];
    if (systemAdmin(user)) {
      return spec("users", {
        where: [facilityId && ["facilityId", "==", facilityId], departmentId && ["departmentId", "==", departmentId], ...filters],
        orderBy,
      });
    }
    if (role?.includes("patient")) throw forbidden("Patient accounts are managed by system administrators");
    if (facilityId && facilityId !== user.facilityId) throw forbidden();
    const filter = (u) => userScope(user, u);
    if (departmentId) {
      if (ctx.departmentId !== departmentId) throw forbidden();
      return spec("users", { where: [["departmentId", "==", departmentId], ...filters], orderBy, filter });
    }
    const own = [["facilityId", "==", user.facilityId]];
    const pendingRoles = (role ?? ["doctor", "nurse"]).filter((r) => r === "doctor" || r === "nurse");
    const unassigned =
      (!status || status === "pending") && pendingRoles.length
        ? [
            ["facilityId", "==", null],
            ["status", "==", "pending"],
            eq("role", pendingRoles),
            ...(q ? prefix("nameLower", q) : []),
          ]
        : null;
    const ownBranch = [...own, ...filters];
    if (!unassigned) return spec("users", { where: ownBranch.filter(Boolean), orderBy, filter });
    return spec("users", { or: [ownBranch.filter(Boolean), unassigned], orderBy, filter });
  },

  // Directory of active staff. Patients only see doctors.
  practitioners(user, { role, facilityId, departmentId, q } = {}) {
    const roles = user.role === "patient" ? ["doctor"] : role ? [role] : ["doctor", "nurse"];
    if (user.role === "patient" && role === "nurse") throw forbidden("Patients can only list doctors");
    return spec("users", {
      where: [
        eq("role", roles),
        ["status", "==", "active"],
        facilityId && ["facilityId", "==", facilityId],
        departmentId && ["departmentId", "==", departmentId],
        ...(q ? prefix("nameLower", q) : []),
      ],
      orderBy: [["nameLower", "asc", str]],
    });
  },

  notifications(user, { unread } = {}) {
    return spec("notifications", {
      where: [["userId", "==", user.id], unread !== undefined && ["read", "==", !unread]],
      orderBy: [["createdAt", "desc", ts]],
    });
  },

  systemAlerts(user, { status, severity } = {}) {
    return spec("systemAlerts", {
      where: [
        !systemAdmin(user) && ["facilityId", "==", user.facilityId],
        status && eq("status", status),
        severity && eq("severity", severity),
      ],
      orderBy: [["createdAt", "desc", ts]],
    });
  },

  facilities(user, { status } = {}) {
    if (user.role !== "admin" && status && status !== "active") throw forbidden();
    const s = user.role === "admin" ? status : "active";
    return spec("facilities", { where: [s && ["status", "==", s]], orderBy: [["name", "asc", str]] });
  },

  departments(user, { facilityId, status } = {}) {
    let f = facilityId;
    if (!systemAdmin(user)) {
      if (!user.facilityId) throw forbidden("You are not assigned to a facility");
      if (facilityId && facilityId !== user.facilityId) throw forbidden();
      f = user.facilityId;
    }
    if (user.role !== "admin" && status && status !== "active") throw forbidden();
    const s = user.role === "admin" ? status : "active";
    return spec("departments", {
      where: [f && ["facilityId", "==", f], s && ["status", "==", s]],
      orderBy: [["name", "asc", str]],
    });
  },

  vitals(user, patientId, { status } = {}) {
    if (user.role === "patient" && status?.includes("entered-in-error")) throw forbidden();
    return spec("vitals", {
      path: `patients/${patientId}/vitals`,
      where: [eq("status", status ?? ["final"])],
      orderBy: [["recordedAt", "desc", ts]],
    });
  },

  messages(_user, conversationId) {
    return spec("messages", { path: `conversations/${conversationId}/messages`, orderBy: [["createdAt", "desc", ts]] });
  },
};

// Role-specific dashboard counters (§4.2). Every value is a count() over one of these specs.
// ctx.ownPatientId: the caller's own patient record (patients only).
export function dashboardSpecs(user, now, { ownPatientId, startOfDay, endOfDay } = {}) {
  const upcoming = ["pending", "confirmed"];
  const count = (collection, where) => spec(collection, { where });
  const noOrder = (s) => ({ ...s, orderBy: [] });
  if (user.role === "patient") {
    return {
      upcomingAppointments: count("appointments", [["patientId", "==", ownPatientId], eq("status", upcoming), ["start", ">=", now]]),
      activePrescriptions: count("prescriptions", [["patientId", "==", ownPatientId], ["status", "==", "active"]]),
      unreadNotifications: count("notifications", [["userId", "==", user.id], ["read", "==", false]]),
    };
  }
  if (user.role === "doctor") {
    return {
      patients: count("patients", [["careTeam", "array-contains", user.id]]),
      appointmentsToday: count("appointments", [
        ["doctorId", "==", user.id],
        eq("status", ["pending", "confirmed", "checked-in", "completed"]),
        ["start", ">=", startOfDay],
        ["start", "<", endOfDay],
      ]),
      pendingAppointments: count("appointments", [["doctorId", "==", user.id], ["status", "==", "pending"], ["start", ">=", now]]),
      preliminaryRecords: count("medicalRecords", [["authorId", "==", user.id], ["status", "==", "preliminary"]]),
      activePrescriptions: count("prescriptions", [["prescriberId", "==", user.id], ["status", "==", "active"]]),
    };
  }
  if (user.role === "nurse") {
    const taskScope = user.departmentId ? ["departmentId", "==", user.departmentId] : ["assigneeId", "==", user.id];
    return {
      patientsUnderCare: noOrder(scoped.patients(user, {})),
      criticalPatients: noOrder(scoped.patients(user, { acuity: "critical" })),
      tasksDueToday: count("careTasks", [taskScope, eq("status", OPEN_TASK), ["dueAt", "<", endOfDay]]),
      overdueTasks: spec("careTasks", {
        where: [taskScope, eq("status", OPEN_TASK), ["dueAt", "<", now]],
        orderBy: [["dueAt", "asc", ts]],
      }),
    };
  }
  const facility = systemAdmin(user) ? null : ["facilityId", "==", user.facilityId];
  const users = (...where) => count("users", [facility, ...where]);
  const unassignedPending = !systemAdmin(user) && [
    ["facilityId", "==", null],
    ["status", "==", "pending"],
    eq("role", ["doctor", "nurse"]),
  ];
  return {
    doctors: users(["role", "==", "doctor"], ["status", "==", "active"]),
    nurses: users(["role", "==", "nurse"], ["status", "==", "active"]),
    patients: count("patients", [facility]),
    admittedPatients: count("patients", [facility, ["admitted", "==", true]]),
    pendingStaff: users(["status", "==", "pending"]),
    ...(unassignedPending && { pendingUnassigned: count("users", unassignedPending) }),
    upcomingAppointments: count("appointments", [facility, eq("status", upcoming), ["start", ">=", now]]),
    activeSystemAlerts: count("systemAlerts", [facility, ["status", "==", "active"]]),
    totalUsers: users(),
    activeUsers: users(["status", "==", "active"]),
    disabledUsers: users(["status", "==", "disabled"]),
  };
}

// Bounded report scans (§2.18). ctx.departmentId has been verified for facility admins.
export function reportSpecs(user, { from, to, facilityId, departmentId } = {}) {
  const inPeriod = [
    ["start", ">=", from],
    ["start", "<", to],
  ];
  const sys = systemAdmin(user);
  if (facilityId && !sys) throw forbidden("facilityId is for system administrators");
  if (departmentId && user.role !== "admin") throw forbidden("departmentId is for administrators");
  const noOrder = (s) => ({ ...s, orderBy: [] });
  if (user.role === "doctor") {
    return {
      scope: { type: "practitioner", id: user.id },
      patients: noOrder(scoped.patients(user, {})),
      appointments: spec("appointments", { where: [["doctorId", "==", user.id], ...inPeriod] }),
      prescriptions: spec("prescriptions", { where: [["prescriberId", "==", user.id]] }),
    };
  }
  if (user.role === "nurse") {
    return {
      scope: { type: "department", id: user.departmentId ?? null },
      patients: noOrder(scoped.patients(user, {})),
      appointments: user.departmentId
        ? spec("appointments", { where: [["departmentId", "==", user.departmentId], ...inPeriod] })
        : null,
      prescriptions: null,
    };
  }
  const f = sys ? facilityId : user.facilityId;
  const facility = f ? ["facilityId", "==", f] : null;
  if (departmentId) {
    return {
      scope: { type: "department", id: departmentId },
      patients: spec("patients", { where: [["admission.departmentId", "==", departmentId]] }),
      appointments: spec("appointments", { where: [["departmentId", "==", departmentId], ...inPeriod] }),
      prescriptions: spec("prescriptions", { where: [facility] }),
      departmentsFilter: departmentId,
    };
  }
  return {
    scope: f ? { type: "facility", id: f } : { type: "system", id: null },
    patients: spec("patients", { where: [facility] }),
    appointments: spec("appointments", { where: [facility, ...inPeriod] }),
    prescriptions: spec("prescriptions", { where: [facility] }),
    departments: spec("departments", { where: [facility] }),
  };
}

// Fixed-shape internal queries (writes, counters, schedules). Kept here so the index test sees them.
export const queries = {
  slotLocks: (doctorId, from, to) =>
    spec("appointmentSlots", {
      where: [["doctorId", "==", doctorId], ["start", ">=", from], ["start", "<", to]],
      orderBy: [["start", "asc", ts]],
    }),
  staffShifts: (staffId, from, to) =>
    spec("shifts", {
      where: [["staffId", "==", staffId], ["start", ">=", new Date(from.getTime() - DAY)], ["start", "<", to]],
      orderBy: [["start", "asc", ts]],
    }),
  departmentShifts: (departmentId, from, to) =>
    spec("shifts", {
      where: [["departmentId", "==", departmentId], ["start", ">=", new Date(from.getTime() - DAY)], ["start", "<", to]],
      orderBy: [["start", "asc", ts]],
    }),
  facilityShifts: (facilityId, from, to) =>
    spec("shifts", {
      where: [["facilityId", "==", facilityId], ["start", ">=", new Date(from.getTime() - DAY)], ["start", "<", to]],
      orderBy: [["start", "asc", ts]],
    }),
  previousShifts: (departmentId, before) =>
    spec("shifts", {
      where: [["departmentId", "==", departmentId], ["end", "<=", before]],
      orderBy: [["end", "desc", ts]],
    }),
  recentFinalVitals: (patientId) =>
    spec("vitals", {
      path: `patients/${patientId}/vitals`,
      where: [["status", "==", "final"]],
      orderBy: [["recordedAt", "desc", ts]],
    }),
  completedAdministrations: (prescriptionId) =>
    spec("medicationAdministrations", {
      where: [["prescriptionId", "==", prescriptionId], ["status", "==", "completed"]],
    }),
  inpatientPrescriptions: (patientIds) =>
    spec("prescriptions", {
      where: [eq("patientId", patientIds), ["status", "==", "active"], ["category", "==", "inpatient"]],
    }),
  openSignupAlerts: (userId) =>
    spec("systemAlerts", {
      where: [["resource.type", "==", "user"], ["resource.id", "==", userId], ["status", "==", "active"]],
    }),
  activeSystemAdmins: () =>
    spec("users", { where: [["role", "==", "admin"], ["status", "==", "active"], ["facilityId", "==", null]] }),
  departmentByName: (facilityId, nameLower) =>
    spec("departments", { where: [["facilityId", "==", facilityId], ["nameLower", "==", nameLower]] }),
  unreadMessages: (conversationId, since) =>
    spec("messages", {
      path: `conversations/${conversationId}/messages`,
      where: [since && ["createdAt", ">", since]],
    }),
  unreadNotifications: (userId) =>
    spec("notifications", { where: [["userId", "==", userId], ["read", "==", false]] }),
  ownPatient: (userId) => spec("patients", { where: [["userId", "==", userId]] }),
  departmentStaff: (departmentId, role) =>
    spec("users", { where: [["departmentId", "==", departmentId], ["status", "==", "active"], role && ["role", "==", role]] }),
  departmentAdmitted: (departmentId) => spec("patients", { where: [["admission.departmentId", "==", departmentId]] }),
  departmentAppointments: (departmentId, from, to) =>
    spec("appointments", {
      where: [
        ["departmentId", "==", departmentId],
        eq("status", ["pending", "confirmed", "checked-in", "completed"]),
        ["start", ">=", from],
        ["start", "<", to],
      ],
    }),
};

function toMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  return new Date(v).getTime();
}
