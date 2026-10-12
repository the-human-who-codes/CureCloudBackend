// User account (§2.1) and the embedded Practitioner profile (§2.2).
import {
  EmergencyContact,
  Identifier,
  ROLES,
  STAFF_ROLES,
  auditFields,
  csv,
  email,
  id,
  instant,
  isoTimestamp,
  listQuery,
  namePart,
  opt,
  page,
  personName,
  phone,
  searchQuery,
  statusReason,
  storedMeta,
  storedTimestamp,
  text,
} from "./common.js";
import { z } from "./zod.js";

export const USER_STATUSES = ["pending", "active", "disabled"];
export const LICENCE_BODIES = { doctor: "hpcsa", nurse: "sanc" };

export const licenceNumber = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9/-]{4,20}$/, "Invalid licence number");

const year = z.number().int().min(1940).max(2100);

export const Qualification = z
  .object({ title: text(120), institution: text(120), year })
  .strict()
  .openapi("Qualification");

// Fields a doctor or nurse may edit on their own profile (PATCH /me).
export const PRACTITIONER_SELF_FIELDS = ["specialization", "qualifications", "practisingSince", "officeLocation", "bio"];

const practitionerSelfShape = {
  specialization: opt(text(100)),
  qualifications: z.array(Qualification).max(10),
  practisingSince: opt(year),
  officeLocation: opt(text(200)),
  bio: opt(text(1000)),
};

export const Practitioner = z
  .object({
    licenceBody: z.enum(["hpcsa", "sanc"]),
    licenceNumber: opt(licenceNumber),
    ...practitionerSelfShape,
    qualifications: practitionerSelfShape.qualifications.default([]),
  })
  .openapi("Practitioner");

export const PractitionerSelfUpdate = z.object(practitionerSelfShape).partial().strict();
export const PractitionerAdminUpdate = z
  .object({ ...practitionerSelfShape, licenceNumber: opt(licenceNumber) })
  .partial()
  .strict();

const shape = (ts) => ({
  email,
  name: personName,
  givenName: opt(namePart),
  familyName: opt(namePart),
  phone: opt(z.string()),
  photoUrl: opt(z.string().url()),
  role: z.enum(ROLES),
  status: z.enum(USER_STATUSES),
  statusReason: opt(statusReason),
  facilityId: z.string().nullable(),
  departmentId: opt(z.string()),
  identifier: opt(Identifier),
  emergencyContact: opt(EmergencyContact),
  practitioner: opt(Practitioner),
  ...auditFields(ts),
});

export const UserStored = z.object({ ...shape(storedTimestamp), ...storedMeta, nameLower: z.string() });

// PII fields are optional in the response because redaction removes them (§3.4).
export const User = z
  .object({ id, ...shape(isoTimestamp), lastSignInAt: opt(isoTimestamp), emailVerified: z.boolean().optional() })
  .partial({ email: true, phone: true, identifier: true, emergencyContact: true })
  .openapi("User");
export const UserPage = page(User, "UserPage");

export const PractitionerSummary = z
  .object({
    id,
    name: z.string(),
    role: z.enum(STAFF_ROLES),
    email: z.string().optional(), // omitted for patient callers
    specialization: z.string().nullable(),
    photoUrl: z.string().nullable(),
    facilityId: z.string().nullable(),
    facilityName: z.string().nullable(),
    departmentId: z.string().nullable(),
    departmentName: z.string().nullable(),
  })
  .openapi("PractitionerSummary");
export const PractitionerSummaryPage = page(PractitionerSummary, "PractitionerSummaryPage");
export const PractitionerSummaryList = z
  .object({ data: z.array(PractitionerSummary) })
  .openapi("PractitionerSummaryList");

// --- Requests -----------------------------------------------------------------------------------

export const SignupRequest = z
  .object({
    email,
    password: z.string().min(8, "Password must be at least 8 characters").max(128),
    name: personName,
    phone,
    role: z.enum(STAFF_ROLES),
    identifier: Identifier,
    licenceNumber: licenceNumber.optional(),
    specialization: text(100).optional(),
  })
  .strict()
  .openapi("SignupRequest");

export const SignupResponse = z
  .object({ id, status: z.literal("pending") })
  .openapi("SignupResponse");

export const MeCreateRequest = z
  .object({
    name: personName.optional(),
    phone: phone.optional(),
    birthDate: z.string().optional(), // validated as isoDate by the patient model
    sex: z.enum(["female", "male", "intersex", "unknown"]).optional(),
  })
  .strict();

export const MeUpdateRequest = z
  .object({
    name: personName,
    givenName: opt(namePart),
    familyName: opt(namePart),
    phone: opt(phone),
    emergencyContact: opt(EmergencyContact),
    practitioner: PractitionerSelfUpdate,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("MeUpdateRequest");

export const UserListQuery = listQuery
  .extend({
    role: csv(ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
    facilityId: id.optional(),
    departmentId: id.optional(),
    q: searchQuery.optional(),
  })
  .strict();

export const UserUpdateRequest = z
  .object({
    role: z.enum(["doctor", "nurse", "admin"]),
    status: z.enum(USER_STATUSES),
    statusReason: opt(statusReason),
    facilityId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
    departmentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
    practitioner: PractitionerAdminUpdate,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("UserUpdateRequest");

export const PractitionerListQuery = listQuery
  .extend({
    role: z.enum(STAFF_ROLES).optional(),
    facilityId: id.optional(),
    departmentId: id.optional(),
    q: searchQuery.optional(),
  })
  .strict();

export const BusyQuery = z.object({ from: instant.optional(), to: instant.optional() }).strict();
export const BusyResponse = z
  .object({ data: z.array(z.object({ start: isoTimestamp, end: isoTimestamp })) })
  .openapi("BusyResponse");
