// AuditEvent (§2.20): append-only write audit. Records who changed which fields, never values.
import { ROLES, RESOURCE_TYPES, id, storedTimestamp } from "./common.js";
import { z } from "./zod.js";

export const AUDIT_ACTIONS = ["create", "update", "status-change", "delete"];
export const AUDIT_RESOURCE_TYPES = [
  ...RESOURCE_TYPES,
  "vitals",
  "medication-administration",
  "care-team",
  "admission",
  "shift",
  "department",
  "facility",
  "notification",
  "user-preferences",
];

export const AuditEventStored = z.object({
  at: storedTimestamp,
  actorId: z.string(),
  actorRole: z.enum([...ROLES, "system"]),
  action: z.enum(AUDIT_ACTIONS),
  resource: z.object({ type: z.enum(AUDIT_RESOURCE_TYPES), id }),
  patientId: id.nullable(),
  changedFields: z.array(z.string()),
  schemaVersion: z.literal(2),
});
