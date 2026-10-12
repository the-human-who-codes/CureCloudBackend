// CareTask (§2.10): nursing work items.
import { auditFields, csv, id, instant, isoTimestamp, listQuery, opt, page, storedMeta, storedTimestamp, text } from "./common.js";
import { z } from "./zod.js";

export const TASK_CATEGORIES = [
  "vitals",
  "medication",
  "assessment",
  "wound-care",
  "hygiene",
  "mobility",
  "specimen",
  "doctor-round",
  "admin",
  "other",
];
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"];
export const TASK_STATUSES = ["open", "in-progress", "completed", "cancelled"];
export const TASK_TRANSITIONS = {
  open: ["in-progress", "cancelled"],
  "in-progress": ["open", "completed", "cancelled"],
};

const shape = (ts) => ({
  patientId: opt(id),
  patientName: opt(z.string()),
  facilityId: z.string(),
  departmentId: opt(z.string()), // patient tasks: the admission department or null; ward tasks: required
  title: text(200),
  description: opt(text(2000)),
  category: z.enum(TASK_CATEGORIES),
  priority: z.enum(TASK_PRIORITIES),
  dueAt: ts,
  status: z.enum(TASK_STATUSES),
  assigneeId: opt(z.string()),
  assigneeName: opt(z.string()),
  startedAt: opt(ts),
  completedAt: opt(ts),
  completedBy: opt(z.string()),
  completionNote: opt(text(1000)),
  ...auditFields(ts),
});

export const CareTaskStored = z.object({ ...shape(storedTimestamp), ...storedMeta });
export const CareTask = z.object({ id, ...shape(isoTimestamp) }).openapi("CareTask");
export const CareTaskPage = page(CareTask, "CareTaskPage");

export const CareTaskListQuery = listQuery
  .extend({
    assigneeId: z.union([z.literal("me"), z.literal("unassigned"), id]).optional(),
    departmentId: id.optional(),
    patientId: id.optional(),
    status: csv(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    dueBefore: instant.optional(),
    completedBy: z.literal("me").optional(),
    completedAfter: instant.optional(),
  })
  .strict();

export const CareTaskCreateRequest = z
  .object({
    patientId: id.optional(),
    title: text(200),
    description: text(2000).optional(),
    category: z.enum(TASK_CATEGORIES),
    priority: z.enum(TASK_PRIORITIES).default("normal"),
    dueAt: instant,
    assigneeId: id.optional(),
    departmentId: id.optional(),
  })
  .strict()
  // Patient tasks take their department from the admission; ward-level tasks must name one (§2.10).
  .superRefine((v, ctx) => {
    if (v.patientId && v.departmentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["departmentId"], message: "Patient tasks take departmentId from the admission" });
    }
    if (!v.patientId && !v.departmentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["departmentId"], message: "Ward-level tasks need a departmentId" });
    }
  })
  .openapi("CareTaskCreateRequest");

export const CareTaskUpdateRequest = z
  .object({
    status: z.enum(TASK_STATUSES),
    assigneeId: id.nullable(),
    title: text(200),
    description: text(2000).nullable(),
    priority: z.enum(TASK_PRIORITIES),
    dueAt: instant,
    completionNote: text(1000),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("CareTaskUpdateRequest");
