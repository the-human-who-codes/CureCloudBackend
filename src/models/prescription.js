// Prescription (§2.8, FHIR MedicationRequest) and MedicationAdministration (§2.9).
import {
  auditFields,
  csv,
  id,
  instant,
  isoDate,
  isoTimestamp,
  listQuery,
  opt,
  page,
  statusReason,
  storedMeta,
  storedTimestamp,
  text,
  timeOfDay,
} from "./common.js";
import { z } from "./zod.js";

export const PRESCRIPTION_STATUSES = ["active", "on-hold", "completed", "stopped", "entered-in-error"];
export const PRESCRIPTION_CATEGORIES = ["inpatient", "outpatient"];
export const ROUTES = ["oral", "sublingual", "iv", "im", "sc", "topical", "inhaled", "rectal", "ophthalmic", "otic", "nasal", "other"];

// Default administration times per frequency (SAST wall clock). null = must be supplied.
export const FREQUENCY_TIMES = {
  once: null,
  "once-daily": ["08:00"],
  "twice-daily": ["08:00", "20:00"],
  "three-times-daily": ["08:00", "14:00", "20:00"],
  "four-times-daily": ["06:00", "12:00", "18:00", "22:00"],
  "every-4-hours": ["02:00", "06:00", "10:00", "14:00", "18:00", "22:00"],
  "every-6-hours": ["00:00", "06:00", "12:00", "18:00"],
  "every-8-hours": ["06:00", "14:00", "22:00"],
  "at-night": ["21:00"],
  weekly: ["08:00"],
  "as-needed": [],
  custom: null,
};
export const FREQUENCIES = Object.keys(FREQUENCY_TIMES);

// Allowed status transitions (§2.8); everything not listed is terminal.
export const PRESCRIPTION_TRANSITIONS = {
  active: ["on-hold", "completed", "stopped", "entered-in-error"],
  "on-hold": ["active", "stopped", "entered-in-error"],
};

const administrationTimes = z
  .array(timeOfDay)
  .max(12)
  .transform((times) => [...new Set(times)].sort());

const shape = (ts) => ({
  patientId: id,
  patientName: z.string(),
  facilityId: opt(z.string()), // copied from the patient, scopes admin reports
  prescriberId: id,
  prescriberName: z.string(),
  category: z.enum(PRESCRIPTION_CATEGORIES),
  medication: text(200),
  dose: text(50),
  route: z.enum(ROUTES),
  frequency: z.enum(FREQUENCIES),
  frequencyText: opt(text(100)),
  administrationTimes: z.array(timeOfDay),
  instructions: opt(text(2000)),
  refills: z.number().int().min(0).max(12),
  startDate: isoDate,
  endDate: opt(isoDate),
  status: z.enum(PRESCRIPTION_STATUSES),
  statusReason: opt(statusReason),
  appointmentId: opt(id),
  ...auditFields(ts),
});

export const PrescriptionStored = z.object({ ...shape(storedTimestamp), ...storedMeta });
export const Prescription = z.object({ id, ...shape(isoTimestamp) }).openapi("Prescription");
export const PrescriptionPage = page(Prescription, "PrescriptionPage");

export const PrescriptionListQuery = listQuery
  .extend({
    patientId: id.optional(),
    prescriberId: z.union([z.literal("me"), id]).optional(),
    status: csv(PRESCRIPTION_STATUSES).optional(),
    category: z.enum(PRESCRIPTION_CATEGORIES).optional(),
  })
  .strict();

// Frequency rules shared by create and the frequency defaults (§2.8).
function frequencyRules(v, ctx) {
  if (v.endDate && v.startDate && v.endDate < v.startDate) {
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "endDate must be on or after startDate" });
  }
  if (v.frequency === "custom" && !v.frequencyText) {
    ctx.addIssue({ code: "custom", path: ["frequencyText"], message: "frequencyText is required for custom" });
  }
  const times = v.administrationTimes;
  if (v.frequency === "once" && times?.length !== 1) {
    ctx.addIssue({ code: "custom", path: ["administrationTimes"], message: "once requires exactly one time" });
  }
  if (v.frequency === "custom" && !times?.length) {
    ctx.addIssue({ code: "custom", path: ["administrationTimes"], message: "custom requires at least one time" });
  }
  if (v.frequency === "as-needed" && times?.length) {
    ctx.addIssue({ code: "custom", path: ["administrationTimes"], message: "as-needed has no scheduled times" });
  }
}

export const PrescriptionCreateRequest = z
  .object({
    patientId: id,
    medication: text(200),
    dose: text(50),
    route: z.enum(ROUTES).default("oral"),
    frequency: z.enum(FREQUENCIES),
    frequencyText: text(100).optional(),
    administrationTimes: administrationTimes.optional(),
    instructions: text(2000).optional(),
    refills: z.number().int().min(0).max(12).default(0),
    startDate: isoDate,
    endDate: isoDate.optional(),
    category: z.enum(PRESCRIPTION_CATEGORIES).optional(),
    appointmentId: id.optional(),
  })
  .strict()
  .superRefine(frequencyRules)
  .openapi("PrescriptionCreateRequest");

export const PrescriptionUpdateRequest = z
  .object({
    status: z.enum(PRESCRIPTION_STATUSES),
    statusReason,
    endDate: isoDate.nullable(),
    refills: z.number().int().min(0).max(12),
    instructions: text(2000).nullable(),
    administrationTimes,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("PrescriptionUpdateRequest");

export const RefillRequest = z.object({ note: text(500).optional() }).strict().openapi("RefillRequest");
export const RefillResponse = z.object({ status: z.literal("requested") }).openapi("RefillResponse");

// --- Medication administration (§2.9) -----------------------------------------------------------

export const ADMINISTRATION_STATUSES = ["completed", "not-done", "entered-in-error"];
export const NOT_DONE_REASONS = ["patient-refused", "patient-unavailable", "clinically-held", "medication-unavailable", "other"];

const administrationShape = (ts) => ({
  prescriptionId: id,
  patientId: id,
  patientName: z.string(),
  medication: z.string(),
  dose: z.string(),
  route: z.enum(ROUTES),
  scheduledFor: opt(ts),
  occurredAt: ts,
  status: z.enum(ADMINISTRATION_STATUSES),
  // A NOT_DONE_REASONS value for not-done; free text (≤200) when retracted as entered-in-error.
  statusReason: opt(z.string()),
  notes: opt(text(500)),
  performerId: id,
  performerName: z.string(),
  ...auditFields(ts),
});

export const MedicationAdministrationStored = z.object({ ...administrationShape(storedTimestamp), ...storedMeta });
export const MedicationAdministration = z
  .object({ id, ...administrationShape(isoTimestamp) })
  .openapi("MedicationAdministration");
export const MedicationAdministrationPage = page(MedicationAdministration, "MedicationAdministrationPage");

export const AdministrationListQuery = listQuery
  .extend({
    patientId: id.optional(),
    prescriptionId: id.optional(),
    performerId: z.union([z.literal("me"), id]).optional(),
    status: csv(ADMINISTRATION_STATUSES).optional(),
    from: instant.optional(),
    to: instant.optional(),
  })
  .strict();

export const AdministrationCreateRequest = z
  .object({
    prescriptionId: id,
    scheduledFor: instant.optional(),
    status: z.enum(["completed", "not-done"]),
    statusReason: z.enum(NOT_DONE_REASONS).optional(),
    occurredAt: instant.optional(),
    dose: text(50).optional(),
    notes: text(500).optional(),
  })
  .strict()
  .refine((v) => v.status !== "not-done" || v.statusReason, {
    message: "statusReason is required for not-done",
    path: ["statusReason"],
  })
  .openapi("AdministrationCreateRequest");

export const AdministrationRetractRequest = z
  .object({ status: z.literal("entered-in-error"), statusReason })
  .strict()
  .openapi("AdministrationRetractRequest");

export const ScheduledDose = z
  .object({
    prescriptionId: id,
    patientId: id,
    patientName: z.string(),
    room: opt(z.string()),
    bed: opt(z.string()),
    allergies: z.array(z.string()),
    medication: z.string(),
    dose: z.string(),
    route: z.string(),
    instructions: opt(z.string()),
    scheduledFor: isoTimestamp,
    status: z.enum(["upcoming", "due", "overdue", "given", "not-given"]),
    administrationId: z.string().optional(),
  })
  .openapi("ScheduledDose");

export const MedicationScheduleQuery = z.object({ date: isoDate.optional(), departmentId: id.optional() }).strict();
export const MedicationSchedule = z
  .object({ data: z.array(ScheduledDose), prn: z.array(Prescription) })
  .openapi("MedicationSchedule");
