// Shift (§2.12): staff schedule, including leave.
import { ROLES, auditFields, id, instant, isoTimestamp, listQuery, opt, page, storedMeta, storedTimestamp, text } from "./common.js";
import { z } from "./zod.js";

export const SHIFT_TYPES = ["morning", "afternoon", "night", "day", "on-call", "leave"];
export const SHIFT_STATUSES = ["scheduled", "cancelled"];
export const MAX_SHIFT_HOURS = 24;

const shape = (ts) => ({
  staffId: id,
  staffName: z.string(),
  staffRole: z.enum(ROLES),
  facilityId: z.string(),
  departmentId: opt(z.string()),
  type: z.enum(SHIFT_TYPES),
  start: ts,
  end: ts,
  status: z.enum(SHIFT_STATUSES),
  handoverNote: opt(text(2000)), // redacted per §3.4
  handoverAt: opt(ts),
  ...auditFields(ts),
});

export const ShiftStored = z.object({ ...shape(storedTimestamp), ...storedMeta });
export const Shift = z.object({ id, ...shape(isoTimestamp) }).openapi("Shift");
export const ShiftPage = page(Shift, "ShiftPage");

export const ShiftListQuery = listQuery
  .extend({
    staffId: z.union([z.literal("me"), id]).optional(),
    departmentId: id.optional(),
    facilityId: id.optional(), // system admins only
    from: instant.optional(),
    to: instant.optional(),
  })
  .strict();

export const CurrentShift = z
  .object({
    shift: Shift.nullable(),
    previousHandover: z.object({ note: z.string(), staffName: z.string(), at: isoTimestamp }).nullable(),
    onDuty: z.array(
      z.object({ staffId: id, staffName: z.string(), staffRole: z.enum(ROLES), type: z.enum(SHIFT_TYPES) }),
    ),
  })
  .openapi("CurrentShift");

export const ShiftCreateRequest = z
  .object({ staffId: id, type: z.enum(SHIFT_TYPES), start: instant, end: instant, departmentId: id.optional() })
  .strict()
  .openapi("ShiftCreateRequest");

export const ShiftUpdateRequest = z
  .object({
    type: z.enum(SHIFT_TYPES),
    start: instant,
    end: instant,
    departmentId: id.nullable(),
    status: z.literal("cancelled"),
    handoverNote: text(2000),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("ShiftUpdateRequest");
