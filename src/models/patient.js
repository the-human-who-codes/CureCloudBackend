// Patient (§2.5): demographics, clinical summary and the current admission.
import {
  ACUITIES,
  Address,
  EmergencyContact,
  Identifier,
  SEXES,
  auditFields,
  booleanQuery,
  email,
  icd10,
  id,
  isoDate,
  isoTimestamp,
  listQuery,
  namePart,
  opt,
  page,
  personName,
  phone,
  searchQuery,
  storedMeta,
  storedTimestamp,
  text,
} from "./common.js";
import { latestVitalsShape } from "./vitals.js";
import { z } from "./zod.js";

export const PATIENT_STATUSES = ["active", "inactive", "deceased"];
export const BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
export const ALLERGY_SEVERITIES = ["mild", "moderate", "severe"];

export const Allergy = z
  .object({
    substance: text(100),
    reaction: opt(text(200)),
    severity: z.enum(ALLERGY_SEVERITIES),
    notedOn: opt(isoDate),
  })
  .strict()
  .openapi("Allergy");

export const Condition = z
  .object({
    name: text(120),
    code: opt(icd10),
    since: opt(isoDate),
    notes: opt(text(500)),
  })
  .strict()
  .openapi("Condition");

const admissionShape = (ts) => ({
  departmentId: z.string().nullable(), // null only for rooms carried over by the v1 migration
  departmentName: z.string(),
  ward: opt(text(60)),
  room: opt(text(30)),
  bed: opt(text(30)),
  admittedAt: ts,
  admittedBy: z.string(),
  attendingDoctorId: opt(id),
});

export const Admission = z.object(admissionShape(isoTimestamp)).openapi("Admission");
export const AdmissionStored = z.object(admissionShape(storedTimestamp));

// Clinical fields: visible to self and clinical access only (§3.4).
export const CLINICAL_FIELDS = ["allergies", "noKnownAllergies", "chronicConditions", "bloodType", "latestVitals", "acuity"];

const shape = (ts) => ({
  userId: z.string().nullable(),
  facilityId: z.string().nullable(),
  folderNumber: opt(z.string().regex(/^[A-Za-z0-9/-]{1,30}$/)),
  status: z.enum(PATIENT_STATUSES),
  deceasedAt: opt(isoDate),
  name: personName,
  givenName: opt(namePart),
  familyName: opt(namePart),
  birthDate: opt(isoDate),
  sex: z.enum(SEXES),
  phone: opt(z.string()),
  email: opt(z.string()),
  address: opt(Address),
  emergencyContact: opt(EmergencyContact),
  identifier: opt(Identifier),
  bloodType: opt(z.enum(BLOOD_TYPES)),
  allergies: z.array(Allergy).max(50),
  noKnownAllergies: z.boolean(),
  chronicConditions: z.array(Condition).max(50),
  acuity: z.enum(ACUITIES),
  admission: opt(z.object(admissionShape(ts))),
  careTeam: z.array(z.string()).max(50),
  latestVitals: opt(z.object(latestVitalsShape(ts))),
  ...auditFields(ts),
});

export const PatientStored = z.object({
  ...shape(storedTimestamp),
  ...storedMeta,
  nameLower: z.string(),
  conditionCategories: z.array(z.string()),
  admitted: z.boolean(), // equality filter for ?admitted=true and the admitted counters
});

// Redacted fields (identifier, clinical fields) are optional in the response.
export const Patient = z
  .object({ id, ...shape(isoTimestamp) })
  .partial({
    identifier: true,
    allergies: true,
    noKnownAllergies: true,
    chronicConditions: true,
    bloodType: true,
    latestVitals: true,
    acuity: true,
  })
  .openapi("Patient");
export const PatientPage = page(Patient, "PatientPage");

// --- Requests -----------------------------------------------------------------------------------

const demographicShape = {
  name: personName,
  givenName: opt(namePart),
  familyName: opt(namePart),
  birthDate: opt(isoDate),
  sex: z.enum(SEXES),
  phone: opt(phone),
  email: opt(email),
  address: opt(Address),
  emergencyContact: opt(EmergencyContact),
  folderNumber: opt(z.string().trim().regex(/^[A-Za-z0-9/-]{1,30}$/, "Invalid folder number")),
};

const clinicalShape = {
  bloodType: opt(z.enum(BLOOD_TYPES)),
  allergies: z.array(Allergy).max(50),
  noKnownAllergies: z.boolean(),
  chronicConditions: z.array(Condition).max(50),
  acuity: z.enum(ACUITIES),
};

const allergyConsistency = (v) => !(v.noKnownAllergies === true && v.allergies?.length > 0);
const allergyMessage = {
  message: "noKnownAllergies can only be true when allergies is empty",
  path: ["noKnownAllergies"],
};

export const PatientCreateRequest = z
  .object({
    ...demographicShape,
    ...clinicalShape,
    identifier: Identifier,
    facilityId: id, // system admins only
  })
  .partial()
  .required({ name: true })
  .strict()
  .refine(allergyConsistency, allergyMessage)
  .openapi("PatientCreateRequest");

export const PatientUpdateRequest = z
  .object({
    ...demographicShape,
    ...clinicalShape,
    identifier: Identifier,
    status: z.enum(PATIENT_STATUSES),
    deceasedAt: opt(isoDate),
    facilityId: id,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .refine(allergyConsistency, allergyMessage)
  .openapi("PatientUpdateRequest");

export const PatientListQuery = listQuery
  .extend({
    q: searchQuery.optional(),
    acuity: z.enum(ACUITIES).optional(),
    admitted: booleanQuery.optional(),
    facilityId: id.optional(),
  })
  .strict();

export const CareTeamAddRequest = z.object({ userId: id }).strict().openapi("CareTeamAddRequest");
export const CareTeamParams = z.object({ id, userId: id });

const locationShape = { ward: opt(text(60)), room: opt(text(30)), bed: opt(text(30)) };

export const AdmitRequest = z
  .object({ departmentId: id, ...locationShape, attendingDoctorId: opt(id) })
  .strict()
  .openapi("AdmitRequest");

export const AdmissionUpdateRequest = z
  .object({ departmentId: id, ...locationShape, attendingDoctorId: opt(id) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("AdmissionUpdateRequest");

export const DischargeRequest = z
  .object({ dischargeNote: text(2000).optional() })
  .strict()
  .openapi("DischargeRequest");
