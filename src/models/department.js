// Department (§2.4). Doubles as the ward used for nurse scoping.
import { auditFields, id, isoTimestamp, listQuery, opt, page, phone, storedMeta, storedTimestamp, text } from "./common.js";
import { z } from "./zod.js";

export const DEPARTMENT_STATUSES = ["active", "archived"];

const shape = (ts) => ({
  facilityId: id,
  name: text(120, 2),
  headId: opt(id),
  headName: opt(z.string()),
  location: opt(text(200)),
  phone: opt(phone),
  bedCapacity: z.number().int().min(0).max(10000),
  status: z.enum(DEPARTMENT_STATUSES),
  ...auditFields(ts),
});

export const DepartmentStats = z
  .object({
    staff: z.number().int(),
    doctors: z.number().int(),
    nurses: z.number().int(),
    admittedPatients: z.number().int(),
    occupancyRate: z.number().min(0).nullable(),
    appointmentsToday: z.number().int(),
  })
  .openapi("DepartmentStats");

export const DepartmentStored = z.object({ ...shape(storedTimestamp), ...storedMeta, nameLower: z.string() });
export const Department = z
  .object({ id, ...shape(isoTimestamp), stats: DepartmentStats.optional() })
  .openapi("Department");
export const DepartmentPage = page(Department, "DepartmentPage");

export const DepartmentListQuery = listQuery
  .extend({
    facilityId: id.optional(),
    include: z.literal("stats").optional(),
    status: z.enum(DEPARTMENT_STATUSES).optional(),
  })
  .strict();

export const DepartmentCreateRequest = z
  .object({
    facilityId: id.optional(), // system admins only; facility admins always create in their own facility
    name: text(120, 2),
    headId: opt(id),
    location: opt(text(200)),
    phone: opt(phone),
    bedCapacity: z.number().int().min(0).max(10000),
  })
  .strict()
  .openapi("DepartmentCreateRequest");

export const DepartmentUpdateRequest = z
  .object({
    name: text(120, 2),
    headId: opt(id),
    location: opt(text(200)),
    phone: opt(phone),
    bedCapacity: z.number().int().min(0).max(10000),
    status: z.enum(DEPARTMENT_STATUSES),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("DepartmentUpdateRequest");
