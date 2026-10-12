// Pure v1 → v2 document transforms (docs/domain-model.md §6). Each takes the stored document
// ({ id, ...data }) and a read-only context, and returns an update map or null when the document is
// already migrated. Removed or renamed fields are copied to legacy.<field> and deleted (DELETE).
import { Timestamp } from "firebase-admin/firestore";
import { normalizePhone, parseZaId } from "../../src/models/common.js";
import { FREQUENCY_TIMES } from "../../src/models/prescription.js";

export const DELETE = Symbol("delete");
const SLOT_MS = 15 * 60e3;
const PRIORITIES = ["stable", "moderate", "high", "critical"];
const LICENCE_BODIES = { doctor: "hpcsa", nurse: "sanc" };

const isMigrated = (doc) => (doc.schemaVersion ?? 1) >= 2;
const has = (doc, field) => Object.prototype.hasOwnProperty.call(doc, field);
const present = (v) => v !== undefined && v !== null && v !== "";

// Starts an update for a document: legacy moves, defaults, and the v2 stamp.
function builder(doc, ctx) {
  const update = {};
  return {
    update,
    move(field) {
      if (!has(doc, field)) return undefined;
      update[`legacy.${field}`] = doc[field];
      update[field] = DELETE;
      return doc[field];
    },
    setDefault(field, value) {
      if (!has(doc, field)) update[field] = value;
    },
    finish() {
      if (!has(doc, "createdAt")) update.createdAt = ctx.now;
      update.updatedAt = ctx.now;
      update.updatedBy = "system";
      update.schemaVersion = 2;
      return update;
    },
  };
}

// The fields an audit event lists for a migrated document: top-level names only, never values.
export function changedFields(update) {
  const skip = new Set(["schemaVersion", "updatedAt", "updatedBy", "createdAt"]);
  return [...new Set(Object.keys(update).map((k) => k.split(".")[0]))].filter((k) => !skip.has(k) && k !== "legacy").sort();
}

function identifierFrom(nationalId) {
  if (!present(nationalId)) return null;
  const value = String(nationalId).replace(/\s+/g, "");
  return { type: parseZaId(value) ? "za-id" : "other", value };
}

export function transformUser(doc, ctx) {
  if (isMigrated(doc)) return null;
  const b = builder(doc, ctx);
  const { update } = b;
  const staff = doc.role === "doctor" || doc.role === "nurse";

  const phoneNumber = b.move("phoneNumber");
  const nationalId = b.move("nationalId");
  const specialization = b.move("specialization");
  if (doc.role === "patient") {
    // The linked Patient becomes the source of contact data (moved by transformPatient).
    b.move("phone");
    b.move("emergencyContact");
    update.phone = null;
    update.emergencyContact = null;
    update.identifier = null;
  } else {
    update.phone = present(phoneNumber) ? normalizePhone(String(phoneNumber)) : (doc.phone ?? null);
    update.identifier = identifierFrom(nationalId) ?? doc.identifier ?? null;
    b.setDefault("emergencyContact", null);
  }
  if (staff) {
    update.practitioner = {
      licenceBody: LICENCE_BODIES[doc.role],
      licenceNumber: doc.practitioner?.licenceNumber ?? null,
      specialization: specialization ?? doc.practitioner?.specialization ?? null,
      qualifications: doc.practitioner?.qualifications ?? [],
    };
    if (!present(doc.facilityId)) update.facilityId = ctx.defaultFacilityId;
  } else {
    if (doc.role === "admin" && doc.practitioner) b.move("practitioner");
    update.practitioner = null;
    b.setDefault("facilityId", null); // admins keep null: system admins
  }
  if (typeof doc.email === "string" && doc.email !== doc.email.trim().toLowerCase()) {
    update.email = doc.email.trim().toLowerCase();
  }
  b.setDefault("departmentId", null);
  b.setDefault("statusReason", null);
  update.nameLower = String(doc.name ?? "").trim().toLowerCase();
  b.setDefault("createdBy", doc.id);
  return b.finish();
}

// "120/80" → { systolic: 120, diastolic: 80 }; invalid strings yield null.
export function parseBloodPressure(value) {
  if (value && typeof value === "object") return value;
  const m = /^(\d{2,3})\/(\d{2,3})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const [systolic, diastolic] = [Number(m[1]), Number(m[2])];
  return systolic > diastolic ? { systolic, diastolic } : null;
}

const mgdlToMmol = (mgdl) => Math.round((mgdl / 18) * 10) / 10;

// Converts a v1 vitals map (panel or patient.vitals) to v2 measurement fields.
function convertMeasurements(v) {
  const out = {};
  for (const k of ["heartRate", "respiratoryRate", "temperature", "oxygenSaturation", "weight", "height", "painScore"]) {
    if (typeof v[k] === "number") out[k] = v[k];
  }
  if (has(v, "bloodPressure")) {
    const bp = parseBloodPressure(v.bloodPressure);
    if (bp) out.bloodPressure = bp;
  }
  if (typeof v.bloodSugar === "number") out.bloodGlucose = mgdlToMmol(v.bloodSugar);
  if (typeof v.bloodGlucose === "number") out.bloodGlucose = v.bloodGlucose;
  return out;
}

export function transformPatient(doc, ctx) {
  if (isMigrated(doc)) return null;
  const b = builder(doc, ctx);
  const { update } = b;
  const user = doc.userId ? ctx.users.get(doc.userId) : null;

  const dateOfBirth = b.move("dateOfBirth");
  update.birthDate = dateOfBirth ?? doc.birthDate ?? null;
  const priority = b.move("priority");
  update.acuity = PRIORITIES.includes(priority) ? priority : (doc.acuity ?? "stable");
  const vitals = b.move("vitals");
  if (vitals && typeof vitals === "object") {
    const converted = convertMeasurements(vitals);
    update.latestVitals = Object.keys(converted).length
      ? { ...converted, recordedAt: vitals.recordedAt ?? doc.createdAt ?? ctx.now }
      : null;
  } else b.setDefault("latestVitals", null);
  const room = b.move("room");
  update.admission = present(room)
    ? { departmentId: null, departmentName: "Unassigned", room: String(room), admittedAt: doc.createdAt ?? ctx.now, admittedBy: "system" }
    : (doc.admission ?? null);
  update.admitted = Boolean(update.admission);
  b.move("nextMed");

  b.setDefault("status", "active");
  b.setDefault("deceasedAt", null);
  b.setDefault("sex", "unknown");
  b.setDefault("allergies", []);
  b.setDefault("noKnownAllergies", false);
  b.setDefault("chronicConditions", []);
  b.setDefault("conditionCategories", []);
  b.setDefault("identifier", null);
  b.setDefault("folderNumber", null);
  b.setDefault("givenName", null);
  b.setDefault("familyName", null);
  b.setDefault("address", null);
  b.setDefault("bloodType", null);
  b.setDefault("careTeam", []);
  b.setDefault("userId", null);
  if (!has(doc, "facilityId")) update.facilityId = (doc.careTeam ?? []).length ? ctx.defaultFacilityId : null;
  update.nameLower = String(doc.name ?? "").trim().toLowerCase();
  if (!present(doc.email)) update.email = user?.email ?? null;
  // Contact data moves from the linked account, only where the patient field is empty.
  if (!present(doc.phone)) update.phone = present(user?.phoneNumber) ? normalizePhone(String(user.phoneNumber)) : (user?.phone ?? null);
  if (!present(doc.emergencyContact)) update.emergencyContact = user?.emergencyContact ?? null;
  b.setDefault("createdBy", doc.userId ?? "system");
  return b.finish();
}

export function transformVitals(doc, ctx) {
  if (isMigrated(doc)) return null;
  const b = builder(doc, ctx);
  const { update } = b;
  if (has(doc, "bloodPressure")) {
    const bp = parseBloodPressure(doc.bloodPressure);
    if (typeof doc.bloodPressure === "string") {
      update["legacy.bloodPressure"] = doc.bloodPressure;
      update.bloodPressure = bp;
    }
  }
  if (has(doc, "bloodSugar")) {
    const mgdl = b.move("bloodSugar");
    update.bloodGlucose = typeof mgdl === "number" ? mgdlToMmol(mgdl) : null;
  }
  const recordedBy = b.move("recordedBy");
  update.createdBy = doc.createdBy ?? recordedBy ?? "system";
  update.createdByName = ctx.users.get(update.createdBy)?.name ?? "Unknown";
  update.patientId = ctx.patientId;
  b.setDefault("status", "final");
  b.setDefault("statusReason", null);
  b.setDefault("notes", null);
  if (!has(doc, "recordedAt")) update.recordedAt = doc.createdAt ?? ctx.now;
  if (!has(doc, "createdAt")) update.createdAt = doc.recordedAt ?? ctx.now;
  return b.finish();
}

const APPOINTMENT_TYPES = { "general checkup": "check-up", "follow-up": "follow-up", consultation: "consultation" };

export function transformAppointment(doc, ctx) {
  if (isMigrated(doc)) return null;
  const b = builder(doc, ctx);
  const { update } = b;
  const scheduledAt = b.move("scheduledAt");
  let start = scheduledAt ?? doc.start ?? null;
  if (!start && doc.date && doc.time) start = Timestamp.fromDate(new Date(`${doc.date}T${doc.time}:00+02:00`));
  b.move("date");
  b.move("time");
  if (start) {
    update.start = start;
    update.end = Timestamp.fromMillis(start.toMillis() + 30 * 60e3);
  }
  update.durationMinutes = 30;
  const notes = b.move("notes");
  update.reason = notes ?? doc.reason ?? null;
  const mapped = APPOINTMENT_TYPES[String(doc.type ?? "").trim().toLowerCase()];
  if (!mapped || mapped !== doc.type) {
    update["legacy.type"] = doc.type ?? null;
    update.type = mapped ?? "other";
  }
  const doctor = ctx.users.get(doc.doctorId);
  update.facilityId = doc.facilityId ?? doctor?.facilityId ?? ctx.defaultFacilityId;
  update.departmentId = doc.departmentId ?? doctor?.departmentId ?? null;
  b.setDefault("cancellationReason", null);
  b.setDefault("cancelledBy", null);
  b.setDefault("checkedInAt", null);
  b.setDefault("patientUserId", null);
  b.setDefault("createdBy", doc.patientUserId ?? "system");
  return b.finish();
}

// appointmentSlots/{doctorId}_{epochMillis}: add the fields the busy-times query needs.
export function transformSlot(doc) {
  if (doc.doctorId && doc.start) return null;
  const m = /^(.+)_(\d+)$/.exec(doc.id);
  if (!m) return null;
  return { doctorId: m[1], start: Timestamp.fromMillis(Number(m[2])) };
}

// Active appointments on a 15-minute boundary get the locks for every unit of their duration.
export function missingSlotLocks(appointment) {
  if (!["pending", "confirmed"].includes(appointment.status) || !appointment.start) return [];
  const start = appointment.start.toMillis();
  if (start % SLOT_MS !== 0) return []; // grandfathered: keeps its single legacy lock
  return [1].map((i) => ({
    id: `${appointment.doctorId}_${start + i * SLOT_MS}`,
    data: { doctorId: appointment.doctorId, start: Timestamp.fromMillis(start + i * SLOT_MS), appointmentId: appointment.id },
  }));
}

const FREQUENCIES = {
  "once daily": "once-daily",
  "twice daily": "twice-daily",
  "three times daily": "three-times-daily",
  "four times daily": "four-times-daily",
  "as needed": "as-needed",
  "at night": "at-night",
};

export function transformPrescription(doc, ctx) {
  if (isMigrated(doc)) return null;
  const b = builder(doc, ctx);
  const { update } = b;
  const doctorId = b.move("doctorId");
  const doctorName = b.move("doctorName");
  update.prescriberId = doctorId ?? doc.prescriberId ?? "unknown";
  update.prescriberName = doctorName ?? doc.prescriberName ?? "Unknown";
  const dosage = b.move("dosage");
  update.dose = dosage ?? doc.dose ?? "";
  const notes = b.move("notes");
  update.instructions = notes ?? doc.instructions ?? null;
  const original = doc.frequency;
  const frequency = FREQUENCIES[String(original ?? "").trim().toLowerCase()] ?? (FREQUENCY_TIMES[original] !== undefined ? original : "custom");
  if (frequency !== original) {
    update["legacy.frequency"] = original ?? null;
    update.frequency = frequency;
  }
  update.frequencyText = frequency === "custom" ? String(original ?? "") : null;
  update.administrationTimes = doc.administrationTimes ?? (frequency === "custom" ? ["08:00"] : FREQUENCY_TIMES[frequency] ?? []);
  b.setDefault("route", "oral");
  b.setDefault("category", "outpatient");
  if (doc.status === "discontinued") {
    update["legacy.status"] = "discontinued";
    update.status = "stopped";
  }
  b.setDefault("statusReason", null);
  b.setDefault("endDate", null);
  b.setDefault("appointmentId", null);
  b.setDefault("refills", 0);
  if (!has(doc, "facilityId")) update.facilityId = ctx.patients.get(doc.patientId)?.facilityId ?? null;
  b.setDefault("createdBy", update.prescriberId);
  return b.finish();
}

function recordCategory(type) {
  const t = String(type ?? "").toLowerCase();
  if (/blood|lab|test/.test(t)) return "lab-result";
  if (/x-ray|scan|mri|\bct\b/.test(t)) return "imaging";
  return "consultation";
}

export function transformMedicalRecord(doc, ctx) {
  if (isMigrated(doc)) return null;
  const b = builder(doc, ctx);
  const { update } = b;
  const doctorId = b.move("doctorId");
  const doctorName = b.move("doctorName");
  update.authorId = doctorId ?? doc.authorId ?? "unknown";
  update.authorName = doctorName ?? doc.authorName ?? "Unknown";
  b.setDefault("authorRole", "doctor");
  const type = b.move("type");
  update.title = type ?? doc.title ?? "Medical record";
  update.category = doc.category ?? recordCategory(type);
  const results = b.move("results");
  update.findings = results ?? doc.findings ?? null;
  if (!has(doc, "effectiveAt")) update.effectiveAt = doc.createdAt ?? ctx.now;
  b.setDefault("labResults", []);
  b.setDefault("addenda", []);
  b.setDefault("statusReason", null);
  b.setDefault("diagnosisCode", null);
  for (const f of ["diagnosis", "treatment", "recommendations", "appointmentId"]) b.setDefault(f, null);
  b.setDefault("createdBy", update.authorId);
  return b.finish();
}

export function transformNotification(doc, ctx) {
  if (isMigrated(doc)) return null;
  const b = builder(doc, ctx);
  const { update } = b;
  if (doc.type === "record") {
    update["legacy.type"] = "record";
    update.type = "medical-record";
  }
  if (!has(doc, "readAt")) update.readAt = doc.read ? (doc.updatedAt ?? null) : null;
  b.setDefault("resource", null);
  if (!has(doc, "expiresAt")) {
    const created = doc.createdAt?.toMillis?.() ?? ctx.now.toMillis();
    update.expiresAt = Timestamp.fromMillis(created + 90 * 86400e3);
  }
  b.setDefault("createdBy", "system");
  return b.finish();
}

export function transformPreferences(doc, ctx) {
  if (isMigrated(doc)) return null;
  const b = builder(doc, ctx);
  for (const f of ["theme", "calendarView", "listView"]) b.move(f);
  return b.finish();
}
