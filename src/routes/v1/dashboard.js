// Role dashboards and the report summary (docs/domain-model.md §2.18, §4.2 "Dashboard and reports").
import { can, dashboardSpecs, getDoc, ownPatient, patientsById, reportSpecs, scoped, systemAdmin } from "../../authz/index.js";
import { DAY, addMs, sastParts, startOfSastDay, toDate } from "../../lib/dates.js";
import { count, fetchAll } from "../../lib/firestore-query.js";
import { badRequest, forbidden } from "../../lib/problem.js";
import { defineRoute } from "../../lib/route.js";
import { raw } from "../../lib/serialize.js";
import {
  ACUITIES,
  AGE_GROUPS,
  APPOINTMENT_STATUSES,
  APPOINTMENT_TYPES,
  Dashboard,
  ReportQuery,
  ReportSummary,
  SEXES,
} from "../../models/index.js";
import { departmentStats } from "./organisation.js";
import { medicationSchedule } from "./prescriptions.js";

const SCAN_CAP = 2000;
const SMALL_CELL = 5;
const zeros = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

async function counters(specs) {
  const entries = await Promise.all(Object.entries(specs).map(async ([k, s]) => [k, await count(s)]));
  return Object.fromEntries(entries);
}

const TASK_CAP = 500;

// Open tasks due today that the nurse may read: patient tasks need clinical access to the patient
// at request time (§2.10), so department scope alone never surfaces a discharged patient's task.
async function visibleDueTasks(user, s) {
  const docs = await fetchAll(s, { limit: TASK_CAP });
  const byId = await patientsById(docs.map((d) => d.get("patientId")));
  return docs.filter((d) => can(user, "care-task:read", raw(d), { patient: byId.get(d.get("patientId")) }));
}

async function nurseDashboard(user, now, specs) {
  const { dueTasks, ...countSpecs } = specs;
  const [counts, schedule, critical, tasks] = await Promise.all([
    counters(countSpecs),
    medicationSchedule(user),
    fetchAll(scoped.patients(user, { acuity: "critical" }), { limit: 5 }),
    visibleDueTasks(user, dueTasks),
  ]);
  const overdue = tasks.filter((d) => toDate(d.get("dueAt")) < now).slice(0, 5);
  const alerts = [
    ...critical.map((d) => ({
      type: "critical-patient",
      patientId: d.id,
      patientName: d.get("name"),
      message: `${d.get("name")} is critical`,
      at: (toDate(d.get("updatedAt")) ?? now).toISOString(),
    })),
    ...schedule.data
      .filter((dose) => dose.status === "overdue")
      .slice(0, 5)
      .map((dose) => ({
        type: "overdue-medication",
        patientId: dose.patientId,
        patientName: dose.patientName,
        message: `${dose.medication} for ${dose.patientName} is overdue`,
        at: dose.scheduledFor,
      })),
    ...overdue.map((d) => ({
      type: "overdue-task",
      ...(d.get("patientId") && { patientId: d.get("patientId"), patientName: d.get("patientName") }),
      message: `Overdue: ${d.get("title")}`,
      at: toDate(d.get("dueAt")).toISOString(),
    })),
  ].slice(0, 10);
  const medicationsDueNow = schedule.data.filter((d) => d.status === "due" || d.status === "overdue").length;
  return {
    role: "nurse",
    counters: {
      patientsUnderCare: counts.patientsUnderCare,
      tasksDueToday: tasks.length,
      medicationsDueNow,
      criticalPatients: counts.criticalPatients,
    },
    alerts,
  };
}

const ageGroup = (birthDate, at) => {
  if (!birthDate) return "unknown";
  const born = new Date(`${birthDate}T00:00:00Z`);
  let age = at.getUTCFullYear() - born.getUTCFullYear();
  if (at.getUTCMonth() < born.getUTCMonth() || (at.getUTCMonth() === born.getUTCMonth() && at.getUTCDate() < born.getUTCDate())) age--;
  if (age < 18) return "0-17";
  if (age < 35) return "18-34";
  if (age < 50) return "35-49";
  if (age < 65) return "50-64";
  return "65+";
};

const top = (map, n = 10) => [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, n);

async function scan(s, select) {
  if (!s) return { docs: [], truncated: false };
  const docs = await fetchAll(s, { limit: SCAN_CAP + 1, select });
  return { docs: docs.slice(0, SCAN_CAP).map(raw), truncated: docs.length > SCAN_CAP };
}

export async function reportSummary(user, { from, to, facilityId, departmentId }) {
  const specs = reportSpecs(user, { from, to, facilityId, departmentId });
  const inPeriod = (v) => {
    const d = toDate(v);
    return d && d >= from && d < to;
  };
  const [patients, appointments, prescriptions] = await Promise.all([
    scan(specs.patients, ["createdAt", "acuity", "sex", "birthDate", "chronicConditions"]),
    scan(specs.appointments, ["start", "status", "type", "departmentId"]),
    scan(specs.prescriptions, ["createdAt", "status", "medication", "patientId"]),
  ]);

  const byAcuity = zeros(ACUITIES);
  const bySex = zeros(SEXES);
  const byAgeGroup = zeros(AGE_GROUPS);
  const conditions = new Map();
  for (const p of patients.docs) {
    if (byAcuity[p.acuity] !== undefined) byAcuity[p.acuity]++;
    if (bySex[p.sex] !== undefined) bySex[p.sex]++;
    byAgeGroup[ageGroup(p.birthDate, to)]++;
    for (const c of p.chronicConditions ?? []) {
      const category = c.code?.slice(0, 3);
      if (!category) continue;
      const entry = conditions.get(category) ?? { category, name: c.name, count: 0 };
      entry.count++;
      conditions.set(category, entry);
    }
  }

  const byStatus = zeros(APPOINTMENT_STATUSES);
  const byType = zeros(APPOINTMENT_TYPES);
  const byDay = new Map();
  const byHour = new Map();
  const perDepartment = new Map();
  for (const a of appointments.docs) {
    if (byStatus[a.status] !== undefined) byStatus[a.status]++;
    if (byType[a.type] !== undefined) byType[a.type]++;
    const { date, hour } = sastParts(toDate(a.start));
    byDay.set(date, (byDay.get(date) ?? 0) + 1);
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
    if (a.departmentId) perDepartment.set(a.departmentId, (perDepartment.get(a.departmentId) ?? 0) + 1);
  }

  let prescriptionSummary = null;
  if (specs.prescriptions) {
    const patientIds = specs.departmentsFilter ? new Set(patients.docs.map((p) => p.id)) : null;
    const rxs = patientIds ? prescriptions.docs.filter((rx) => patientIds.has(rx.patientId)) : prescriptions.docs;
    const meds = new Map();
    for (const rx of rxs) {
      const key = rx.medication.trim().toLowerCase();
      const entry = meds.get(key) ?? { name: rx.medication.trim(), count: 0 };
      entry.count++;
      meds.set(key, entry);
    }
    prescriptionSummary = {
      active: rxs.filter((rx) => rx.status === "active").length,
      newInPeriod: rxs.filter((rx) => inPeriod(rx.createdAt)).length,
      topMedications: top(meds),
    };
  }

  let departments = null;
  if (user.role === "admin") {
    const depts = specs.departmentsFilter
      ? [await getDoc("departments", specs.departmentsFilter)].filter(Boolean)
      : (await fetchAll(specs.departments, { limit: 100 })).map(raw);
    departments = await Promise.all(
      depts.map(async (d) => {
        const stats = await departmentStats(d);
        return {
          departmentId: d.id,
          name: d.name,
          staff: stats.staff,
          admittedPatients: stats.admittedPatients,
          bedCapacity: d.bedCapacity,
          occupancyRate: stats.occupancyRate,
          appointments: perDepartment.get(d.id) ?? 0,
        };
      }),
    );
  }

  const summary = {
    scope: specs.scope,
    period: { from: from.toISOString(), to: to.toISOString() },
    patients: {
      total: patients.docs.length,
      newInPeriod: patients.docs.filter((p) => inPeriod(p.createdAt)).length,
      byAcuity,
      bySex,
      byAgeGroup,
      topConditions: top(conditions).map(({ category, name, count: n }) => ({ category, name, count: n })),
    },
    appointments: {
      total: appointments.docs.length,
      byStatus,
      byType,
      byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, n]) => ({ date, count: n })),
      byHour: [...byHour].sort(([a], [b]) => a - b).map(([hour, n]) => ({ hour, count: n })),
    },
    prescriptions: prescriptionSummary,
    departments,
    meta: {
      generatedAt: new Date().toISOString(),
      truncated: patients.truncated || appointments.truncated || prescriptions.truncated,
    },
  };

  // Admins have no clinical access: small cells (1–4) in clinical aggregates are suppressed.
  if (user.role === "admin") {
    for (const k of ACUITIES) {
      const n = summary.patients.byAcuity[k];
      summary.patients.byAcuity[k] = n > 0 && n < SMALL_CELL ? null : n;
    }
    summary.patients.topConditions = summary.patients.topConditions.filter((c) => c.count >= SMALL_CELL);
    if (summary.prescriptions) {
      summary.prescriptions.topMedications = summary.prescriptions.topMedications.filter((m) => m.count >= SMALL_CELL);
    }
  }
  return summary;
}

export function register(router) {
  defineRoute(router, {
    method: "get",
    path: "/dashboard",
    permission: "dashboard:read",
    summary: "Role-specific dashboard counters (discriminated by role)",
    description:
      "Counts are count() aggregations; the nurse medication counters come from today's medication schedule, and tasksDueToday and the overdue-task alerts only include tasks the nurse may read (patient tasks need current clinical access; at most 500 tasks are considered).",
    tags: ["Dashboard"],
    responses: { 200: Dashboard },
    async handler(req, res) {
      const user = req.user;
      const now = new Date();
      const startOfDay = startOfSastDay(now);
      const ctx = { startOfDay, endOfDay: addMs(startOfDay, DAY) };
      if (user.role === "patient") ctx.ownPatientId = (await ownPatient(user))?.id ?? "-";
      const specs = dashboardSpecs(user, now, ctx);
      if (user.role === "nurse") return res.json(await nurseDashboard(user, now, specs));
      // Facility admins also count pending unassigned staff and system-wide alerts (§4.2).
      const { pendingUnassigned, systemWideAlerts, ...rest } = await counters(specs);
      if (pendingUnassigned !== undefined) rest.pendingStaff += pendingUnassigned;
      if (systemWideAlerts !== undefined) rest.activeSystemAlerts += systemWideAlerts;
      res.json({ role: user.role, counters: rest });
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/reports/summary",
    permission: "report:read",
    summary: "Aggregated report for the caller's scope (default: last 30 days)",
    description:
      "Doctor: care team patients, own appointments and prescriptions. Nurse: department and care team. Facility admin: facility (?departmentId=). System admin: everything or ?facilityId=. Admin clinical aggregates suppress cells below 5. Period at most 366 days; scans are capped at 2,000 documents per collection (meta.truncated).",
    tags: ["Dashboard"],
    request: { query: ReportQuery },
    responses: { 200: ReportSummary },
    async handler(req, res) {
      const user = req.user;
      const q = req.valid.query;
      const to = q.to ? new Date(q.to) : new Date();
      const from = q.from ? new Date(q.from) : addMs(to, -30 * DAY);
      if (from >= to) throw badRequest("from must be before to");
      if (to - from > 366 * DAY) throw badRequest("The period can be at most 366 days");
      if (q.departmentId && user.role === "admin" && !systemAdmin(user)) {
        const dept = await getDoc("departments", q.departmentId);
        if (dept?.facilityId !== user.facilityId) throw forbidden("departmentId must be in your facility");
      }
      res.json(await reportSummary(user, { from, to, facilityId: q.facilityId, departmentId: q.departmentId }));
    },
  });
}
