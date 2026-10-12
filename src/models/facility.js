// Facility (§2.3). Read-only through the API in v1; created by the migration and the seed script.
import { Address, auditFields, email, id, isoTimestamp, listQuery, opt, page, phone, storedMeta, storedTimestamp, text } from "./common.js";
import { z } from "./zod.js";

export const FACILITY_TYPES = ["hospital", "clinic", "community-health-centre"];
export const FACILITY_STATUSES = ["active", "archived"];

const shape = (ts) => ({
  name: text(120, 2),
  type: z.enum(FACILITY_TYPES),
  address: opt(Address),
  phone: opt(phone),
  email: opt(email),
  status: z.enum(FACILITY_STATUSES),
  ...auditFields(ts),
});

export const FacilityStored = z.object({ ...shape(storedTimestamp), ...storedMeta });
export const Facility = z.object({ id, ...shape(isoTimestamp) }).openapi("Facility");
export const FacilityPage = page(Facility, "FacilityPage");

export const FacilityListQuery = listQuery.extend({ status: z.enum(FACILITY_STATUSES).optional() });
