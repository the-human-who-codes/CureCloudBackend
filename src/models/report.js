// ReportSummary (§2.18) and the role-specific dashboards (§4.2). Computed on request, never stored.
import { ACUITIES, SEXES, id, instant, isoTimestamp } from "./common.js";
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES } from "./appointment.js";
import { z } from "./zod.js";

const count = z.number().int();
// Admin reports return null for small cells (1–4) in clinical aggregates.
const cell = count.nullable();
const record = (keys, value) => z.object(Object.fromEntries(keys.map((k) => [k, value])));

export const AGE_GROUPS = ["0-17", "18-34", "35-49", "50-64", "65+", "unknown"];

export const ReportSummary = z
  .object({
    scope: z.object({ type: z.enum(["practitioner", "department", "facility", "system"]), id: z.string().nullable() }),
    period: z.object({ from: isoTimestamp, to: isoTimestamp }),
    patients: z.object({
      total: count,
      newInPeriod: count,
      byAcuity: record(ACUITIES, cell),
      bySex: record(SEXES, count),
      byAgeGroup: record(AGE_GROUPS, count),
      topConditions: z.array(z.object({ category: z.string(), name: z.string(), count })),
    }),
    appointments: z.object({
      total: count,
      byStatus: record(APPOINTMENT_STATUSES, count),
      byType: record(APPOINTMENT_TYPES, count),
      byDay: z.array(z.object({ date: z.string(), count })),
      byHour: z.array(z.object({ hour: z.number().int(), count })),
    }),
    prescriptions: z
      .object({ active: count, newInPeriod: count, topMedications: z.array(z.object({ name: z.string(), count })) })
      .nullable(),
    departments: z
      .array(
        z.object({
          departmentId: z.string(),
          name: z.string(),
          staff: count,
          admittedPatients: count,
          bedCapacity: count,
          occupancyRate: z.number().nullable(),
          appointments: count,
        }),
      )
      .nullable(),
    meta: z.object({ generatedAt: isoTimestamp, truncated: z.boolean() }),
  })
  .openapi("ReportSummary");

export const ReportQuery = z
  .object({ from: instant.optional(), to: instant.optional(), facilityId: id.optional(), departmentId: id.optional() })
  .strict();

const alert = z.object({
  type: z.enum(["critical-patient", "overdue-medication", "overdue-task"]),
  patientId: z.string().optional(),
  patientName: z.string().optional(),
  message: z.string(),
  at: isoTimestamp,
});

export const PatientDashboard = z
  .object({
    role: z.literal("patient"),
    counters: z.object({ upcomingAppointments: count, activePrescriptions: count, unreadNotifications: count }),
  })
  .openapi("PatientDashboard");

export const DoctorDashboard = z
  .object({
    role: z.literal("doctor"),
    counters: z.object({
      patients: count,
      appointmentsToday: count,
      pendingAppointments: count,
      preliminaryRecords: count,
      activePrescriptions: count,
    }),
  })
  .openapi("DoctorDashboard");

export const NurseDashboard = z
  .object({
    role: z.literal("nurse"),
    counters: z.object({ patientsUnderCare: count, tasksDueToday: count, medicationsDueNow: count, criticalPatients: count }),
    alerts: z.array(alert).max(10),
  })
  .openapi("NurseDashboard");

export const AdminDashboard = z
  .object({
    role: z.literal("admin"),
    counters: z.object({
      doctors: count,
      nurses: count,
      patients: count,
      admittedPatients: count,
      pendingStaff: count,
      upcomingAppointments: count,
      activeSystemAlerts: count,
      totalUsers: count,
      activeUsers: count,
      disabledUsers: count,
    }),
  })
  .openapi("AdminDashboard");

export const Dashboard = z
  .discriminatedUnion("role", [PatientDashboard, DoctorDashboard, NurseDashboard, AdminDashboard])
  .openapi("Dashboard");
