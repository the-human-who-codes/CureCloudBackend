// scripts/seed.js writes v2-shaped demo data: every seeded document parses with its stored model and
// the demo pages' endpoints serve it (responses are schema-checked under VALIDATE_RESPONSES=1).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { before, describe, test } from "node:test";
import { promisify } from "node:util";
import * as models from "../src/models/index.js";
import { as, db, googleUser, resetEmulators } from "./helpers.js";

const run = promisify(execFile);
const seed = (email, role) => run(process.execPath, ["scripts/seed.js", email, role], { env: process.env });

const STORED = {
  facilities: models.FacilityStored,
  departments: models.DepartmentStored,
  users: models.UserStored,
  patients: models.PatientStored,
  appointments: models.AppointmentStored,
  appointmentSlots: models.AppointmentSlotStored,
  prescriptions: models.PrescriptionStored,
  medicalRecords: models.MedicalRecordStored,
  careTasks: models.CareTaskStored,
  shifts: models.ShiftStored,
  notifications: models.NotificationStored,
  conversations: models.ConversationStored,
};

describe("seed", () => {
  const u = {};

  before(async () => {
    await resetEmulators();
    for (const role of ["doctor", "nurse", "admin", "patient"]) u[role] = await googleUser(`${role}@seed.test`, `Seed ${role}`);
  });

  // Each run makes the signed-in account the demo doctor, nurse, admin or patient, so every role is
  // checked right after its own seed.
  const seedAs = async (role) => {
    const { stdout } = await seed(`${role}@seed.test`, role);
    assert.match(stdout, new RegExp(`as ${role}`));
    return as(u[role].token);
  };

  test("nurse", async () => {
    const nurse = await seedAs("nurse");
    assert.equal((await nurse.get("/me").expect(200)).body.user.role, "nurse");
    assert.equal((await nurse.get("/patients").expect(200)).body.data.length, 5);
    const schedule = await nurse.get("/medication-schedule").expect(200);
    assert.equal(schedule.body.data.length, 3); // twice daily + once daily for the admitted patient
    assert.equal(schedule.body.prn.length, 1);
    assert.equal((await nurse.get("/dashboard").expect(200)).body.role, "nurse");
    assert.equal((await nurse.get("/care-tasks").expect(200)).body.data.length, 3);
    await nurse.get("/shifts/current").expect(200); // the day shift is current only between 07:00 and 19:00
  });

  test("doctor", async () => {
    const doctor = await seedAs("doctor");
    assert.equal((await doctor.get("/appointments").expect(200)).body.data.length, 3);
    assert.equal((await doctor.get("/prescriptions").expect(200)).body.data.length, 3);
    await doctor.get("/medical-records").expect(200);
    await doctor.get("/reports/summary").expect(200);
  });

  test("admin", async () => {
    const admin = await seedAs("admin");
    assert.ok((await admin.get("/users").expect(200)).body.data.length >= 3);
    const departments = await admin.get("/departments?include=stats").expect(200);
    assert.equal(departments.body.data.find((d) => d.id === "dept-medicine").stats.admittedPatients, 3);
    await admin.get("/shifts").expect(200);
    await admin.get("/dashboard").expect(200);
  });

  test("patient", async () => {
    const patient = await seedAs("patient");
    const me = await patient.get("/me").expect(200);
    assert.deepEqual(me.body.patient.latestVitals.bloodPressure, { systolic: 120, diastolic: 80 });
    assert.equal((await patient.get("/notifications").expect(200)).body.data.length, 2);
    await patient.get("/practitioners").expect(200);
    await patient.get("/appointments").expect(200);
  });

  test("every seeded document matches its stored model", async () => {
    for (const [collection, schema] of Object.entries(STORED)) {
      const snap = await db.collection(collection).get();
      assert.ok(snap.size > 0, collection);
      for (const d of snap.docs) {
        const result = schema.safeParse(d.data());
        assert.ok(result.success, `${collection}/${d.id}: ${JSON.stringify(result.error?.issues.slice(0, 3))}`);
      }
    }
    for (const d of (await db.collectionGroup("vitals").get()).docs) {
      assert.ok(models.VitalSignsStored.safeParse(d.data()).success, d.ref.path);
    }
  });
});
