// Appointment (§2.7), lifecycle modelled on FHIR Appointment.
import { auditFields, csv, id, instant, isoTimestamp, listQuery, opt, page, statusReason, storedMeta, storedTimestamp, text } from "./common.js";
import { z } from "./zod.js";

export const APPOINTMENT_STATUSES = ["pending", "confirmed", "checked-in", "completed", "cancelled", "no-show"];
export const ACTIVE_APPOINTMENT_STATUSES = ["pending", "confirmed", "checked-in"];
export const TERMINAL_APPOINTMENT_STATUSES = ["completed", "cancelled", "no-show"];
export const APPOINTMENT_TYPES = ["check-up", "consultation", "follow-up", "procedure", "test", "vaccination", "other"];
export const DURATIONS = [15, 30, 45, 60];

const duration = z
  .number()
  .int()
  .refine((v) => DURATIONS.includes(v), "durationMinutes must be 15, 30, 45 or 60");

const shape = (ts) => ({
  patientId: id,
  patientName: z.string(),
  patientUserId: opt(z.string()),
  doctorId: id,
  doctorName: z.string(),
  facilityId: z.string(),
  departmentId: opt(z.string()),
  start: ts,
  end: ts,
  durationMinutes: z.number().int(),
  type: z.enum(APPOINTMENT_TYPES),
  reason: opt(text(1000)),
  status: z.enum(APPOINTMENT_STATUSES),
  cancellationReason: opt(statusReason),
  cancelledBy: opt(z.string()),
  checkedInAt: opt(ts),
  ...auditFields(ts),
});

export const AppointmentStored = z.object({ ...shape(storedTimestamp), ...storedMeta });
// reason and cancellationReason are redacted for callers without self or clinical access.
export const Appointment = z.object({ id, ...shape(isoTimestamp) }).openapi("Appointment");
export const AppointmentPage = page(Appointment, "AppointmentPage");

// Slot locks: appointmentSlots/{doctorId}_{epochMillis}, one per 15-minute unit.
export const AppointmentSlotStored = z.object({ doctorId: id, start: storedTimestamp, appointmentId: id });

export const AppointmentListQuery = listQuery
  .extend({
    patientId: id.optional(),
    doctorId: z.union([z.literal("me"), id]).optional(),
    departmentId: id.optional(),
    status: csv(APPOINTMENT_STATUSES).optional(),
    from: instant.optional(),
    to: instant.optional(),
  })
  .strict();

export const AppointmentCreateRequest = z
  .object({
    doctorId: id,
    patientId: id.optional(), // staff only; patients always book for themselves
    start: instant,
    durationMinutes: duration.optional(),
    type: z.enum(APPOINTMENT_TYPES).default("check-up"),
    reason: text(1000).optional(),
  })
  .strict()
  .openapi("AppointmentCreateRequest");

export const AppointmentUpdateRequest = z
  .object({
    status: z.enum(["confirmed", "checked-in", "completed", "cancelled", "no-show"]),
    cancellationReason: statusReason,
    start: instant,
    durationMinutes: duration,
    type: z.enum(APPOINTMENT_TYPES),
    reason: opt(text(1000)),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("AppointmentUpdateRequest");
