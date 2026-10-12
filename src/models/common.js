// Shared value types, enums and primitives used by every entity model (docs/domain-model.md §1, §2).
import { Timestamp } from "firebase-admin/firestore";
import { z } from "./zod.js";

export const SCHEMA_VERSION = 2;

export const ROLES = ["patient", "nurse", "doctor", "admin"];
export const STAFF_ROLES = ["doctor", "nurse"];
export const PROVINCES = [
  "eastern-cape",
  "free-state",
  "gauteng",
  "kwazulu-natal",
  "limpopo",
  "mpumalanga",
  "north-west",
  "northern-cape",
  "western-cape",
];
export const SEXES = ["female", "male", "intersex", "unknown"];
export const ACUITIES = ["stable", "moderate", "high", "critical"];
export const LANGUAGES = ["en", "af", "zu", "xh"];
export const RESOURCE_TYPES = [
  "appointment",
  "prescription",
  "medical-record",
  "care-task",
  "conversation",
  "user",
  "patient",
];

// Stored but never serialized (§3.4).
export const HIDDEN_FIELDS = [
  "legacy",
  "nameLower",
  "conditionCategories",
  "expiresAt",
  "schemaVersion",
  "lastReadAt",
  "admitted",
];

export const opt = (schema) => schema.nullable().optional();

// --- Time ---------------------------------------------------------------------------------------

// Firestore Timestamp in stored documents; ISO 8601 UTC string in the API.
export const storedTimestamp = z.custom((v) => v instanceof Timestamp, "Expected a Firestore Timestamp");
export const isoTimestamp = z
  .string()
  .datetime()
  .openapi({ format: "date-time", example: "2026-10-12T07:00:00.000Z" });

// Request instants must carry an offset (Z or ±hh:mm).
export const instant = z
  .string()
  .datetime({ offset: true, message: "Expected an ISO 8601 instant with offset" })
  .openapi({ format: "date-time", example: "2026-10-12T09:00:00+02:00" });

export function isValidDate(value) {
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine(isValidDate, "Invalid calendar date")
  .openapi({ format: "date", example: "1990-05-04" });

export const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm (24h)")
  .openapi({ example: "08:00" });

// --- Identifiers and text -----------------------------------------------------------------------

// Firestore document IDs (auto IDs, Auth UIDs and the deterministic IDs in §1.1).
export const id = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, "Invalid ID")
  .openapi({ example: "Zr3kq0Yh6x2bWm1PpL9c" });

export const personName = z.string().trim().min(2).max(120);
export const namePart = z.string().trim().min(1).max(60);
export const text = (max, min = 1) => z.string().trim().min(min).max(max);
export const statusReason = text(200);

export const email = z.string().trim().toLowerCase().email().max(254);

// Accepts local SA formats ("082 123 4567", "27821234567") and stores E.164.
export function normalizePhone(raw) {
  const s = raw.replace(/[\s().-]/g, "");
  if (/^0\d{9}$/.test(s)) return `+27${s.slice(1)}`;
  if (/^27\d{9}$/.test(s)) return `+${s}`;
  if (/^00[1-9]\d{7,14}$/.test(s)) return `+${s.slice(2)}`;
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  return null;
}

export const phone = z
  .string()
  .trim()
  .max(30)
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid phone number" });
      return z.NEVER;
    }
    return normalized;
  })
  .openapi({ type: "string", example: "+27821234567" });

export const countryCode = z
  .string()
  .regex(/^[A-Z]{2}$/, "Expected an ISO 3166-1 alpha-2 code")
  .openapi({ example: "ZA" });

// ICD-10 code, e.g. E11.9.
export const icd10 = z
  .string()
  .trim()
  .regex(/^[A-Z]\d{2}(\.\d{1,2})?$/, "Expected an ICD-10 code such as E11.9");

// --- South African ID numbers -------------------------------------------------------------------

function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// Returns { birthDate, sex } for a valid 13-digit SA ID number, otherwise null.
export function parseZaId(value) {
  if (!/^\d{13}$/.test(value) || !luhnValid(value)) return null;
  const yy = Number(value.slice(0, 2));
  const century = yy > new Date().getUTCFullYear() % 100 ? 1900 : 2000;
  const birthDate = `${century + yy}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
  if (!isValidDate(birthDate)) return null;
  return { birthDate, sex: Number(value.slice(6, 10)) < 5000 ? "female" : "male" };
}

// --- Shared value types (§2) --------------------------------------------------------------------

export const Address = z
  .object({
    line1: text(200),
    line2: opt(text(200)),
    suburb: opt(text(100)),
    city: text(100),
    province: z.enum(PROVINCES),
    postalCode: z.string().regex(/^\d{4}$/, "Expected a 4-digit postal code"),
    country: countryCode.default("ZA"),
  })
  .strict()
  .openapi("Address");

export const EmergencyContact = z
  .object({ name: personName, relationship: text(50), phone })
  .strict()
  .openapi("EmergencyContact");

export const IDENTIFIER_TYPES = ["za-id", "passport", "asylum-seeker-permit", "other"];

export const Identifier = z
  .object({
    type: z.enum(IDENTIFIER_TYPES),
    value: z.string().trim(),
    country: countryCode.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type === "za-id") {
      if (!parseZaId(v.value)) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "Invalid South African ID number" });
      }
    } else if (!/^[A-Za-z0-9-]{4,20}$/.test(v.value)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Invalid document number" });
    }
    if (v.type === "passport" && !v.country) {
      ctx.addIssue({ code: "custom", path: ["country"], message: "country is required for passports" });
    }
  })
  .openapi("Identifier");

export const ResourceRef = z
  .object({ type: z.enum(RESOURCE_TYPES), id })
  .openapi("ResourceRef");

// --- Audit fields (§1.3) ------------------------------------------------------------------------

export const auditFields = (ts) => ({
  createdAt: ts,
  createdBy: z.string(),
  updatedAt: ts,
  updatedBy: z.string(),
});

// Fields every stored document carries in addition to its entity fields.
export const storedMeta = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  legacy: z.record(z.unknown()).optional(),
};

// --- Lists and query strings (§1.7, §1.8, §4.1) -------------------------------------------------

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(2000).optional(),
});

export const page = (schema, name) =>
  z.object({ data: z.array(schema), nextCursor: z.string().nullable() }).openapi(name);

// Comma-separated multi-value filter: ?status=pending,confirmed (at most 10 values, Firestore `in`).
export const csv = (values) =>
  z
    .string()
    .transform((s) => [...new Set(s.split(",").map((v) => v.trim()).filter(Boolean))])
    .pipe(z.array(z.enum(values)).min(1).max(10))
    .openapi({ type: "string", example: values.slice(0, 2).join(",") });

export const booleanQuery = z.enum(["true", "false"]).transform((v) => v === "true");

// Name prefix search (§2.19): lowercased, at most 60 characters.
export const searchQuery = z.string().trim().toLowerCase().min(1).max(60);

// "me" or an ID, for actor filters (§3.3).
export const actorId = z.union([z.literal("me"), id]);

export const idParam = z.object({ id });
