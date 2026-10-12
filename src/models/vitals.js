// VitalSigns panel (§2.6), modelled on FHIR's vital-signs Observation profile.
import { auditFields, csv, id, instant, isoTimestamp, listQuery, opt, page, statusReason, storedMeta, storedTimestamp, text } from "./common.js";
import { z } from "./zod.js";

export const VITALS_STATUSES = ["final", "entered-in-error"];

const oneDecimal = (min, max) =>
  z
    .number()
    .min(min)
    .max(max)
    .transform((v) => Math.round(v * 10) / 10);
const int = (min, max) => z.number().int().min(min).max(max);

export const BloodPressure = z
  .object({ systolic: int(50, 260), diastolic: int(20, 160) })
  .strict()
  .refine((bp) => bp.systolic > bp.diastolic, "systolic must be greater than diastolic")
  .openapi("BloodPressure");

// Units: mmHg, beats/min, breaths/min, °C, %, mmol/L, kg, cm, 0–10.
export const measurementShape = {
  bloodPressure: BloodPressure,
  heartRate: int(20, 250),
  respiratoryRate: int(4, 60),
  temperature: oneDecimal(30, 45),
  oxygenSaturation: int(50, 100),
  bloodGlucose: oneDecimal(0.5, 50),
  weight: oneDecimal(0.5, 500),
  height: z.number().min(20).max(250),
  painScore: int(0, 10),
};
export const MEASUREMENTS = Object.keys(measurementShape);

const shape = (ts) => ({
  patientId: id,
  recordedAt: ts,
  status: z.enum(VITALS_STATUSES),
  statusReason: opt(statusReason),
  ...Object.fromEntries(MEASUREMENTS.map((k) => [k, opt(measurementShape[k])])),
  notes: opt(text(500)),
  createdByName: z.string(),
  ...auditFields(ts),
});

export const VitalSignsStored = z.object({ ...shape(storedTimestamp), ...storedMeta });
export const VitalSigns = z.object({ id, ...shape(isoTimestamp) }).openapi("VitalSigns");
export const VitalSignsPage = page(VitalSigns, "VitalSignsPage");

// Denormalized on the patient: field-wise merge of final panels plus the newest recordedAt.
export const latestVitalsShape = (ts) => ({
  ...Object.fromEntries(MEASUREMENTS.map((k) => [k, measurementShape[k].optional()])),
  recordedAt: ts,
});
export const LatestVitals = z.object(latestVitalsShape(isoTimestamp)).openapi("LatestVitals");

export const VitalsCreateRequest = z
  .object({ ...measurementShape, recordedAt: instant, notes: text(500) })
  .partial()
  .strict()
  .refine((v) => MEASUREMENTS.some((k) => v[k] !== undefined), "At least one measurement is required")
  .openapi("VitalsCreateRequest");

export const VitalsRetractRequest = z
  .object({ status: z.literal("entered-in-error"), statusReason })
  .strict()
  .openapi("VitalsRetractRequest");

export const VitalsListQuery = listQuery.extend({ status: csv(VITALS_STATUSES).optional() }).strict();
