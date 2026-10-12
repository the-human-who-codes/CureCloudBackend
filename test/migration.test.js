// The v1 → v2 migration (docs/domain-model.md §6): pure transforms, then a dry run, an applied run
// and an idempotent re-run against the emulator. Migrated documents must parse with the stored models.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { before, describe, test } from "node:test";
import { promisify } from "node:util";
import { Timestamp } from "firebase-admin/firestore";
import { runMigration } from "../scripts/lib/migrate.js";
import {
  DELETE,
  changedFields,
  missingSlotLocks,
  parseBloodPressure,
  transformAppointment,
  transformMedicalRecord,
  transformNotification,
  transformPatient,
  transformPrescription,
  transformUser,
  transformVitals,
} from "../scripts/lib/v1-transforms.js";
import {
  AppointmentSlotStored,
  AppointmentStored,
  FacilityStored,
  MedicalRecordStored,
  NotificationStored,
  PatientStored,
  PrescriptionStored,
  UserStored,
  VitalSignsStored,
} from "../src/models/index.js";
import { as, db, googleUser, resetEmulators } from "./helpers.js";

const now = Timestamp.fromDate(new Date("2026-10-12T07:00:00Z"));
const ctx = { now, defaultFacilityId: "default", users: new Map(), patients: new Map() };

describe("migration transforms", () => {
  test("already migrated documents are skipped", () => {
    for (const fn of [transformUser, transformPatient, transformAppointment, transformPrescription, transformMedicalRecord, transformNotification]) {
      assert.equal(fn({ id: "x", schemaVersion: 2 }, ctx), null);
    }
  });

  test("renamed fields move to legacy and are deleted", () => {
    const update = transformPatient({ id: "p", name: "Thandi", dateOfBirth: "1990-05-04", priority: "high", room: "12", nextMed: "Aspirin", careTeam: ["d"] }, ctx);
    assert.equal(update.birthDate, "1990-05-04");
    assert.equal(update["legacy.dateOfBirth"], "1990-05-04");
    assert.equal(update.dateOfBirth, DELETE);
    assert.equal(update.acuity, "high");
    assert.equal(update["legacy.nextMed"], "Aspirin");
    assert.deepEqual(update.admission.room, "12");
    assert.equal(update.admitted, true);
    assert.equal(update.facilityId, "default"); // non-empty care team
    assert.equal(update.schemaVersion, 2);
    assert.equal(update.updatedBy, "system");
    // Audit field lists are names only.
    assert.ok(changedFields(update).includes("birthDate"));
    assert.ok(!changedFields(update).some((f) => f.startsWith("legacy") || f === "schemaVersion"));
  });

  test("vitals: blood pressure strings and mg/dL glucose", () => {
    assert.deepEqual(parseBloodPressure("120/80"), { systolic: 120, diastolic: 80 });
    assert.equal(parseBloodPressure("80/120"), null);
    assert.equal(parseBloodPressure("high"), null);
    const users = new Map([["n1", { name: "Nurse One" }]]);
    const update = transformVitals({ id: "v", bloodPressure: "130/85", bloodSugar: 95, recordedBy: "n1" }, { ...ctx, users, patientId: "p" });
    assert.deepEqual(update.bloodPressure, { systolic: 130, diastolic: 85 });
    assert.equal(update["legacy.bloodPressure"], "130/85");
    assert.equal(update.bloodGlucose, 5.3);
    assert.equal(update["legacy.bloodSugar"], 95);
    assert.equal(update.createdBy, "n1");
    assert.equal(update.createdByName, "Nurse One");
    assert.equal(update.status, "final");
  });

  test("appointments, prescriptions, records and notifications map their enums", () => {
    const start = Timestamp.fromDate(new Date("2026-10-13T07:00:00Z"));
    const appt = transformAppointment({ id: "a", scheduledAt: start, date: "2026-10-13", time: "09:00", type: "General Checkup", notes: "Sugar", doctorId: "d", status: "confirmed" }, ctx);
    assert.equal(appt.type, "check-up");
    assert.equal(appt["legacy.type"], "General Checkup");
    assert.equal(appt.reason, "Sugar");
    assert.equal(appt.end.toMillis() - appt.start.toMillis(), 30 * 60e3);
    assert.equal(appt.facilityId, "default");
    assert.equal(transformAppointment({ id: "b", scheduledAt: start, type: "Dental", doctorId: "d" }, ctx).type, "other");
    assert.deepEqual(missingSlotLocks({ id: "a", doctorId: "d", start, status: "confirmed" }).map((l) => l.id), [`d_${start.toMillis() + 15 * 60e3}`]);
    assert.deepEqual(missingSlotLocks({ id: "a", doctorId: "d", start, status: "cancelled" }), []);

    const rx = transformPrescription({ id: "r", doctorId: "d", doctorName: "Dr D", dosage: "500mg", frequency: "Twice daily", notes: "With food", status: "discontinued" }, ctx);
    assert.equal(rx.prescriberId, "d");
    assert.equal(rx.dose, "500mg");
    assert.equal(rx.frequency, "twice-daily");
    assert.deepEqual(rx.administrationTimes, ["08:00", "20:00"]);
    assert.equal(rx.instructions, "With food");
    assert.equal(rx.status, "stopped");
    const custom = transformPrescription({ id: "s", doctorId: "d", dosage: "1", frequency: "Every other day", status: "active" }, ctx);
    assert.equal(custom.frequency, "custom");
    assert.equal(custom.frequencyText, "Every other day");
    assert.deepEqual(custom.administrationTimes, ["08:00"]);

    assert.equal(transformMedicalRecord({ id: "m", type: "Blood Work", doctorId: "d" }, ctx).category, "lab-result");
    assert.equal(transformMedicalRecord({ id: "m", type: "Chest X-ray", doctorId: "d" }, ctx).category, "imaging");
    assert.equal(transformMedicalRecord({ id: "m", type: "Visit", doctorId: "d" }, ctx).category, "consultation");
    const note = transformNotification({ id: "n", type: "record", read: false, createdAt: now }, ctx);
    assert.equal(note.type, "medical-record");
    assert.equal(note.expiresAt.toMillis() - now.toMillis(), 90 * 86400e3);
  });

  test("users: contact data, identifiers and the practitioner profile", () => {
    const staff = transformUser({ id: "d", role: "doctor", name: "Dr D", email: "D@X.test", phoneNumber: "082 123 4567", nationalId: "9005045800083", specialization: "GP", facilityId: null }, ctx);
    assert.equal(staff.phone, "+27821234567");
    assert.deepEqual(staff.identifier, { type: "za-id", value: "9005045800083" });
    assert.deepEqual(staff.practitioner, { licenceBody: "hpcsa", licenceNumber: null, specialization: "GP", qualifications: [] });
    assert.equal(staff.facilityId, "default");
    assert.equal(staff.email, "d@x.test");
    assert.equal(transformUser({ id: "o", role: "nurse", name: "N", nationalId: "A12345" }, ctx).identifier.type, "other");
    const admin = transformUser({ id: "a", role: "admin", name: "A", facilityId: null, specialization: "x" }, ctx);
    assert.equal(admin.facilityId, undefined); // stays null: a system admin
    assert.equal(admin.practitioner, null);
    assert.equal(admin["legacy.specialization"], "x");
    const patient = transformUser({ id: "p", role: "patient", name: "P", phoneNumber: "0821234567" }, ctx);
    assert.equal(patient.phone, null); // moved to the linked patient
    assert.equal(patient["legacy.phoneNumber"], "0821234567");
  });
});

describe("migration run (emulator)", () => {
  const old = Timestamp.fromDate(new Date(Date.now() - 30 * 86400e3));
  const start = Timestamp.fromMillis(Math.ceil((Date.now() + 3 * 86400e3) / 900e3) * 900e3);
  const ids = {};

  before(async () => {
    await resetEmulators();
    // A patient who signed in with Google under the v1 API, plus v1-shaped clinical data.
    const p = await googleUser("legacy@gmail.test", "Legacy Patient");
    ids.patient = p.uid;
    ids.patientToken = p.token;
    const batch = db.batch();
    batch.set(db.collection("users").doc(p.uid), { name: "Legacy Patient", email: "legacy@gmail.test", role: "patient", status: "active", phoneNumber: "082 555 0101", facilityId: null, createdAt: old });
    batch.set(db.collection("users").doc("doc1"), { name: "Dr. James Wilson", email: "j.wilson@curecloud.test", role: "doctor", status: "active", specialization: "Endocrinology", phoneNumber: null, facilityId: null, createdAt: old });
    batch.set(db.collection("users").doc("admin1"), { name: "Site Admin", email: "admin@curecloud.test", role: "admin", status: "active", facilityId: null, createdAt: old });
    batch.set(db.collection("patients").doc(p.uid), { userId: p.uid, name: "Legacy Patient", dateOfBirth: "1985-02-03", room: null, priority: "stable", nextMed: null, vitals: { bloodPressure: "120/80", heartRate: 72, bloodSugar: 99 }, careTeam: ["doc1"], createdAt: old });
    batch.set(db.collection("patients").doc("walkin1"), { userId: null, name: "Walk In", dateOfBirth: null, room: "101", priority: "critical", nextMed: "Aspirin", vitals: null, careTeam: ["doc1"], createdAt: old });
    batch.set(db.collection("patients").doc(p.uid).collection("vitals").doc("v1"), { bloodPressure: "120/80", heartRate: 72, bloodSugar: 99, recordedBy: "doc1", recordedAt: old, createdAt: old });
    batch.set(db.collection("appointments").doc("appt1"), { patientId: p.uid, patientUserId: p.uid, patientName: "Legacy Patient", doctorId: "doc1", doctorName: "Dr. James Wilson", date: "2026-10-15", time: "09:00", scheduledAt: start, type: "Follow-up", notes: "Regular check-up", status: "confirmed", createdBy: p.uid, createdAt: old, updatedAt: old });
    batch.set(db.collection("appointmentSlots").doc(`doc1_${start.toMillis()}`), { appointmentId: "appt1" });
    batch.set(db.collection("prescriptions").doc("rx1"), { patientId: p.uid, patientName: "Legacy Patient", doctorId: "doc1", doctorName: "Dr. James Wilson", medication: "Metformin", dosage: "500mg", frequency: "Twice daily", startDate: "2026-09-01", endDate: null, refills: 2, notes: null, status: "discontinued", createdAt: old });
    batch.set(db.collection("medicalRecords").doc("mr1"), { patientId: p.uid, patientName: "Legacy Patient", doctorId: "doc1", doctorName: "Dr. James Wilson", type: "Blood Work", diagnosis: "Diabetes", treatment: null, results: "Elevated", recommendations: null, appointmentId: null, status: "final", createdAt: old });
    batch.set(db.collection("notifications").doc("n1"), { userId: p.uid, title: "Record", description: "New record", type: "record", priority: "normal", read: true, createdAt: old, updatedAt: old });
    await batch.commit();
  });

  const get = async (path) => {
    const snap = await db.doc(path).get();
    return { id: snap.id, ...snap.data() };
  };

  test("a dry run writes nothing", async () => {
    const report = await runMigration(db);
    assert.equal(report.collections.patients.migrated, 2);
    assert.equal(report.collections.users.migrated, 3);
    assert.equal(report.collections.facilities.migrated, 1);
    assert.equal(report.collections["appointmentSlots (missing locks)"].migrated, 1);
    // Samples carry IDs and field names only, never values.
    assert.doesNotMatch(JSON.stringify(report), /Metformin|Legacy Patient|0101/);
    assert.equal((await db.collection("facilities").get()).size, 0);
    assert.equal((await get(`patients/${ids.patient}`)).schemaVersion, undefined);
    assert.equal((await db.collection("auditEvents").get()).size, 0);
  });

  test("--apply migrates every document to the stored v2 models", async () => {
    await runMigration(db, { apply: true });
    const check = (schema, doc) => {
      const result = schema.safeParse(doc);
      assert.ok(result.success, `${doc.id}: ${JSON.stringify(result.error?.issues.slice(0, 3))}`);
    };
    check(FacilityStored, await get("facilities/default"));
    const patient = await get(`patients/${ids.patient}`);
    check(PatientStored, patient);
    assert.equal(patient.birthDate, "1985-02-03");
    assert.equal(patient.phone, "+27825550101"); // moved from the user
    assert.equal(patient.email, "legacy@gmail.test");
    assert.deepEqual(patient.latestVitals.bloodPressure, { systolic: 120, diastolic: 80 });
    assert.equal(patient.latestVitals.bloodGlucose, 5.5);
    assert.equal(patient.legacy.dateOfBirth, "1985-02-03");
    const walkIn = await get("patients/walkin1");
    check(PatientStored, walkIn);
    assert.equal(walkIn.admission.room, "101");
    assert.equal(walkIn.admitted, true);
    assert.equal(walkIn.acuity, "critical");

    for (const uid of [ids.patient, "doc1", "admin1"]) check(UserStored, await get(`users/${uid}`));
    const user = await get(`users/${ids.patient}`);
    assert.equal(user.phone, null);
    assert.equal(user.legacy.phoneNumber, "082 555 0101");
    const doctor = await get("users/doc1");
    assert.equal(doctor.practitioner.specialization, "Endocrinology");
    assert.equal(doctor.facilityId, "default");
    assert.equal((await get("users/admin1")).facilityId, null);

    check(VitalSignsStored, await get(`patients/${ids.patient}/vitals/v1`));
    const appt = await get("appointments/appt1");
    check(AppointmentStored, appt);
    assert.equal(appt.type, "follow-up");
    assert.equal(appt.reason, "Regular check-up");
    for (const lock of (await db.collection("appointmentSlots").get()).docs) {
      check(AppointmentSlotStored, { ...lock.data() });
    }
    assert.equal((await db.collection("appointmentSlots").get()).size, 2);
    const rx = await get("prescriptions/rx1");
    check(PrescriptionStored, rx);
    assert.equal(rx.status, "stopped");
    check(MedicalRecordStored, await get("medicalRecords/mr1"));
    const note = await get("notifications/n1");
    check(NotificationStored, note);
    assert.equal(note.type, "medical-record");

    const events = (await db.collection("auditEvents").get()).docs.map((d) => d.data());
    assert.ok(events.every((e) => e.actorId === "system" && e.action === "update"));
    assert.ok(events.some((e) => e.resource.type === "patient" && e.changedFields.includes("birthDate")));
    assert.doesNotMatch(JSON.stringify(events), /Metformin|0101|1985/);
  });

  test("migrated documents work through the API", async () => {
    const me = await as(ids.patientToken).get("/me").expect(200);
    assert.equal(me.body.patient.birthDate, "1985-02-03");
    const rx = await as(ids.patientToken).get("/prescriptions?status=stopped").expect(200);
    assert.equal(rx.body.data[0].dose, "500mg");
    const appts = await as(ids.patientToken).get("/appointments").expect(200);
    assert.equal(appts.body.data[0].type, "follow-up");
  });

  test("re-running changes nothing", async () => {
    const events = (await db.collection("auditEvents").get()).size;
    const report = await runMigration(db, { apply: true });
    for (const [name, s] of Object.entries(report.collections)) assert.equal(s.migrated, 0, name);
    assert.equal((await db.collection("auditEvents").get()).size, events);
  });

  test("the CLI refuses to run without the emulator or a confirmed project", async () => {
    const run = promisify(execFile);
    const env = { ...process.env, FIRESTORE_EMULATOR_HOST: "" };
    await assert.rejects(run(process.execPath, ["scripts/migrate-v1.js"], { env }), /Refusing to run/);
    await assert.rejects(run(process.execPath, ["scripts/migrate-v1.js", "--project", "curecloud1", "--confirm", "other"], { env }), /Refusing to run/);
    const { stdout } = await run(process.execPath, ["scripts/migrate-v1.js"], { env: process.env });
    assert.match(stdout, /Dry run/);
  });
});
