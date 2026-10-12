// MedicalRecord (§2.11): a simplified FHIR Composition / DiagnosticReport.
import { auditFields, csv, icd10, id, instant, isoTimestamp, listQuery, opt, page, statusReason, storedMeta, storedTimestamp, text } from "./common.js";
import { z } from "./zod.js";

export const RECORD_CATEGORIES = [
  "consultation",
  "progress-note",
  "nursing-note",
  "lab-result",
  "imaging",
  "procedure",
  "discharge-summary",
  "referral",
];
export const RECORD_STATUSES = ["preliminary", "final", "amended", "entered-in-error"];
export const LAB_FLAGS = ["normal", "low", "high", "critical-low", "critical-high", "abnormal"];
export const CONTENT_FIELDS = ["diagnosis", "diagnosisCode", "findings", "treatment", "recommendations", "labResults"];

export const LabResult = z
  .object({
    name: text(120),
    code: opt(text(20)),
    value: text(50),
    unit: opt(text(30)),
    referenceRange: opt(text(50)),
    flag: z.enum(LAB_FLAGS),
  })
  .strict()
  .openapi("LabResult");

const addendumShape = (ts) => ({ text: text(5000), authorId: id, authorName: z.string(), createdAt: ts });
export const Addendum = z.object(addendumShape(isoTimestamp)).openapi("Addendum");

const shape = (ts) => ({
  patientId: id,
  patientName: z.string(),
  authorId: id,
  authorName: z.string(),
  authorRole: z.enum(["doctor", "nurse"]),
  category: z.enum(RECORD_CATEGORIES),
  title: text(200),
  effectiveAt: ts,
  status: z.enum(RECORD_STATUSES),
  statusReason: opt(statusReason),
  diagnosis: opt(text(5000)),
  diagnosisCode: opt(icd10),
  findings: opt(text(5000)),
  treatment: opt(text(5000)),
  recommendations: opt(text(5000)),
  labResults: z.array(LabResult).max(50),
  appointmentId: opt(id),
  addenda: z.array(z.object(addendumShape(ts))),
  ...auditFields(ts),
});

export const MedicalRecordStored = z.object({ ...shape(storedTimestamp), ...storedMeta });
export const MedicalRecord = z.object({ id, ...shape(isoTimestamp) }).openapi("MedicalRecord");
export const MedicalRecordPage = page(MedicalRecord, "MedicalRecordPage");

const contentShape = {
  diagnosis: opt(text(5000)),
  diagnosisCode: opt(icd10),
  findings: opt(text(5000)),
  treatment: opt(text(5000)),
  recommendations: opt(text(5000)),
  labResults: z.array(LabResult).max(50),
};

export const hasContent = (r) =>
  Boolean(r.diagnosis || r.findings || r.treatment || (r.labResults && r.labResults.length));
const contentMessage = "At least one of diagnosis, findings, treatment or labResults is required";

export const MedicalRecordCreateRequest = z
  .object({
    patientId: id,
    category: z.enum(RECORD_CATEGORIES),
    title: text(200),
    effectiveAt: instant.optional(),
    status: z.enum(["preliminary", "final"]).default("final"),
    ...contentShape,
    labResults: contentShape.labResults.optional(),
    appointmentId: id.optional(),
  })
  .strict()
  .refine(hasContent, contentMessage)
  .openapi("MedicalRecordCreateRequest");

export const MedicalRecordUpdateRequest = z
  .object({
    title: text(200),
    category: z.enum(RECORD_CATEGORIES),
    effectiveAt: instant,
    ...contentShape,
    status: z.enum(["final", "entered-in-error"]),
    statusReason,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .refine((v) => v.status !== "entered-in-error" || v.statusReason, {
    message: "statusReason is required for entered-in-error",
    path: ["statusReason"],
  })
  .openapi("MedicalRecordUpdateRequest");

export const AddendumCreateRequest = z.object({ text: text(5000) }).strict().openapi("AddendumCreateRequest");

export const MedicalRecordListQuery = listQuery
  .extend({
    patientId: id.optional(),
    authorId: z.union([z.literal("me"), id]).optional(),
    category: z.enum(RECORD_CATEGORIES).optional(),
    status: csv(RECORD_STATUSES).optional(),
  })
  .strict();
