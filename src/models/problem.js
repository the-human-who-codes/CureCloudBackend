// RFC 9457 problem details (§1.9).
import { z } from "./zod.js";

export const PROBLEM_BASE = "https://curecloud1.web.app/problems/";

export const PROBLEMS = {
  "validation-error": { status: 400, title: "Invalid request" },
  "malformed-json": { status: 400, title: "Malformed JSON body" },
  "invalid-cursor": { status: 400, title: "Invalid pagination cursor" },
  unauthenticated: { status: 401, title: "Authentication required" },
  "profile-required": { status: 403, title: "Profile required" },
  "account-pending": { status: 403, title: "Account awaiting approval" },
  "account-disabled": { status: 403, title: "Account disabled" },
  forbidden: { status: 403, title: "Forbidden" },
  "not-found": { status: 404, title: "Not found" },
  conflict: { status: 409, title: "Conflict" },
  "slot-unavailable": { status: 409, title: "Slot unavailable" },
  "invalid-state-transition": { status: 409, title: "Invalid state transition" },
  "record-immutable": { status: 409, title: "Record is immutable" },
  "duplicate-identifier": { status: 409, title: "Duplicate identifier" },
  "already-charted": { status: 409, title: "Dose already charted" },
  internal: { status: 500, title: "Internal server error" },
};

export const Problem = z
  .object({
    type: z.string().url(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    code: z.enum(Object.keys(PROBLEMS)),
    errors: z
      .array(z.object({ path: z.string(), message: z.string(), code: z.string() }))
      .optional(),
  })
  .openapi("Problem");
