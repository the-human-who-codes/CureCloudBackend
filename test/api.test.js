import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { api, bearer, futureDate, googleUser, resetEmulators, signIn, staffUser } from "./helpers.js";

const ADMIN_EMAIL = "admin@curecloud.test";
process.env.BOOTSTRAP_ADMIN_EMAIL = ADMIN_EMAIL;

describe("CureCloud API", () => {
  const ctx = {};

  before(async () => {
    await resetEmulators();
  });

  test("health is public; everything else needs a token", async () => {
    await api().get("/api/health").expect(200, { status: "ok" });
    await api().get("/api/me").expect(401);
    await api().get("/api/me").set(bearer("garbage")).expect(401);
    const res = await api().get("/api/health");
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("CORS allows only CureCloud origins", async () => {
    for (const origin of [
      "https://curecloud1.web.app",
      "https://curecloud1--pr24-abc123.web.app",
      "http://localhost:5173",
    ]) {
      const pre = await api()
        .options("/api/me")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "GET")
        .set("Access-Control-Request-Headers", "authorization")
        .expect(204);
      assert.equal(pre.headers["access-control-allow-origin"], origin);
      assert.match(pre.headers["access-control-allow-headers"], /Authorization/);
    }

    const evil = "https://curecloud1.web.app.evil.com";
    await api().options("/api/me").set("Origin", evil).expect(403);
    const res = await api().get("/api/health").set("Origin", evil).expect(200);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });

  test("staff signup creates a pending account", async () => {
    const payload = {
      email: "Dr.House@curecloud.test",
      password: "password123",
      confirmPassword: "password123",
      fullName: "Gregory House",
      nationalId: "8001015009087",
      role: "doctor",
      phoneNumber: "+27 82 555 0101",
    };
    const res = await api().post("/api/auth/signup").send(payload).expect(201);
    assert.equal(res.body.status, "pending");
    ctx.doctorId = res.body.id;

    await api().post("/api/auth/signup").send(payload).expect(409);
    await api().post("/api/auth/signup").send({ ...payload, email: "x@curecloud.test", role: "admin" }).expect(400);
    await api().post("/api/auth/signup").send({ ...payload, email: "y@curecloud.test", password: "short" }).expect(400);

    ctx.doctorToken = await signIn("dr.house@curecloud.test");
    const blocked = await api().get("/api/patients").set(bearer(ctx.doctorToken)).expect(403);
    assert.match(blocked.body.message, /awaiting admin approval/);
  });

  test("first Google sign-in creates a patient profile", async () => {
    const { uid, token } = await googleUser("thandi@gmail.test", "Thandi Mokoena");
    ctx.patientId = uid;
    ctx.patientToken = token;

    await api().get("/api/me").set(bearer(token)).expect(404);
    const created = await api().post("/api/me").set(bearer(token)).send({ dateOfBirth: "1990-05-04" }).expect(201);
    assert.equal(created.body.user.role, "patient");
    assert.equal(created.body.user.name, "Thandi Mokoena");
    await api().post("/api/me").set(bearer(token)).send({}).expect(409);

    const me = await api().get("/api/me").set(bearer(token)).expect(200);
    assert.equal(me.body.patient.id, uid);
    assert.deepEqual(me.body.patient.careTeam, []);
  });

  test("bootstrap admin approves staff", async () => {
    const { uid, token } = await googleUser(ADMIN_EMAIL, "Site Admin");
    ctx.adminId = uid;
    ctx.adminToken = token;
    const created = await api().post("/api/me").set(bearer(token)).send({}).expect(201);
    assert.equal(created.body.user.role, "admin");

    const pending = await api().get("/api/users?status=pending").set(bearer(token)).expect(200);
    assert.deepEqual(pending.body.users.map((u) => u.id), [ctx.doctorId]);

    await api().patch(`/api/users/${ctx.adminId}`).set(bearer(token)).send({ role: "nurse" }).expect(400);
    await api().patch(`/api/users/${ctx.patientId}`).set(bearer(token)).send({ role: "doctor" }).expect(400);
    await api().get("/api/users").set(bearer(ctx.patientToken)).expect(403);

    const approved = await api()
      .patch(`/api/users/${ctx.doctorId}`)
      .set(bearer(token))
      .send({ status: "active", specialization: "Diagnostics" })
      .expect(200);
    assert.equal(approved.body.user.status, "active");
  });

  test("patients see the doctor directory without PII", async () => {
    const res = await api().get("/api/doctors").set(bearer(ctx.patientToken)).expect(200);
    assert.deepEqual(res.body.doctors, [
      { id: ctx.doctorId, name: "Gregory House", specialization: "Diagnostics", facilityId: null },
    ]);
  });

  test("patient books an appointment; double-booking and past dates are rejected", async () => {
    const slot = { doctorId: ctx.doctorId, date: futureDate(3), time: "09:30", type: "Follow-up" };
    const res = await api().post("/api/appointments").set(bearer(ctx.patientToken)).send(slot).expect(201);
    assert.equal(res.body.appointment.status, "pending");
    assert.equal(res.body.appointment.patientName, "Thandi Mokoena");
    assert.equal(res.body.appointment.doctorName, "Gregory House");
    ctx.appointmentId = res.body.appointment.id;
    ctx.slot = slot;

    await api().post("/api/appointments").set(bearer(ctx.patientToken)).send(slot).expect(409);
    await api()
      .post("/api/appointments")
      .set(bearer(ctx.patientToken))
      .send({ ...slot, date: "2020-01-01" })
      .expect(400);
    await api()
      .post("/api/appointments")
      .set(bearer(ctx.patientToken))
      .send({ ...slot, doctorId: ctx.adminId })
      .expect(404);
  });

  test("booking adds the doctor to the care team and notifies them", async () => {
    const patients = await api().get("/api/patients").set(bearer(ctx.doctorToken)).expect(200);
    assert.deepEqual(patients.body.patients.map((p) => p.id), [ctx.patientId]);

    const appts = await api().get("/api/appointments?upcoming=true").set(bearer(ctx.doctorToken)).expect(200);
    assert.deepEqual(appts.body.appointments.map((a) => a.id), [ctx.appointmentId]);

    const notes = await api().get("/api/notifications?unread=true").set(bearer(ctx.doctorToken)).expect(200);
    assert.equal(notes.body.notifications.length, 1);
    assert.equal(notes.body.notifications[0].title, "New appointment request");
  });

  test("appointment status rules", async () => {
    const url = `/api/appointments/${ctx.appointmentId}`;
    await api().patch(url).set(bearer(ctx.patientToken)).send({ status: "confirmed" }).expect(403);
    await api().patch(url).set(bearer(ctx.doctorToken)).send({ status: "confirmed", notes: "Bring results" }).expect(200);

    const patientNotes = await api().get("/api/notifications").set(bearer(ctx.patientToken)).expect(200);
    assert.match(patientNotes.body.notifications[0].description, /confirmed/);

    // Reschedule resets to pending and frees the old slot
    const moved = await api()
      .patch(url)
      .set(bearer(ctx.patientToken))
      .send({ date: futureDate(4), time: "11:00" })
      .expect(200);
    assert.equal(moved.body.appointment.status, "pending");
    await api().post("/api/appointments").set(bearer(ctx.patientToken)).send(ctx.slot).expect(201);

    await api().patch(url).set(bearer(ctx.patientToken)).send({ status: "cancelled" }).expect(200);
    await api().patch(url).set(bearer(ctx.doctorToken)).send({ status: "confirmed" }).expect(409);
    await api()
      .post("/api/appointments")
      .set(bearer(ctx.patientToken))
      .send({ ...ctx.slot, date: futureDate(4), time: "11:00" })
      .expect(201);
  });

  test("other patients and unassigned nurses cannot see the patient", async () => {
    const other = await googleUser("sipho@gmail.test", "Sipho Dlamini");
    await api().post("/api/me").set(bearer(other.token)).send({}).expect(201);
    await api().get(`/api/patients/${ctx.patientId}`).set(bearer(other.token)).expect(404);
    const theirs = await api()
      .get(`/api/appointments?patientId=${ctx.patientId}`)
      .set(bearer(other.token))
      .expect(200);
    assert.equal(theirs.body.appointments.length, 0); // patients are always scoped to themselves

    const nurse = await staffUser("nurse.joy@curecloud.test", "nurse");
    ctx.nurseToken = nurse.token;
    await api().get(`/api/patients/${ctx.patientId}`).set(bearer(nurse.token)).expect(404);
    await api().get("/api/appointments").set(bearer(nurse.token)).expect(400);
    const list = await api().get("/api/patients").set(bearer(nurse.token)).expect(200);
    assert.equal(list.body.patients.length, 0);
  });

  test("vitals, prescriptions and medical records", async () => {
    const pid = ctx.patientId;
    await api()
      .post(`/api/patients/${pid}/vitals`)
      .set(bearer(ctx.doctorToken))
      .send({ bloodPressure: "120/80", heartRate: 72 })
      .expect(201);
    await api()
      .post(`/api/patients/${pid}/vitals`)
      .set(bearer(ctx.doctorToken))
      .send({ weight: 68 })
      .expect(201);
    await api().post(`/api/patients/${pid}/vitals`).set(bearer(ctx.doctorToken)).send({ heartRate: 900 }).expect(400);
    await api().post(`/api/patients/${pid}/vitals`).set(bearer(ctx.patientToken)).send({ weight: 60 }).expect(403);

    const me = await api().get("/api/me").set(bearer(ctx.patientToken)).expect(200);
    assert.equal(me.body.patient.vitals.bloodPressure, "120/80");
    assert.equal(me.body.patient.vitals.weight, 68);
    const history = await api().get(`/api/patients/${pid}/vitals`).set(bearer(ctx.patientToken)).expect(200);
    assert.equal(history.body.vitals.length, 2);

    const rx = {
      patientId: pid,
      medication: "Metformin",
      dosage: "500mg",
      frequency: "Twice daily",
      startDate: "2026-10-01",
      refills: 2,
    };
    await api().post("/api/prescriptions").set(bearer(ctx.nurseToken)).send(rx).expect(403);
    await api().post("/api/prescriptions").set(bearer(ctx.doctorToken)).send({ ...rx, endDate: "2026-01-01" }).expect(400);
    const created = await api().post("/api/prescriptions").set(bearer(ctx.doctorToken)).send(rx).expect(201);
    const active = await api().get("/api/prescriptions?status=active").set(bearer(ctx.patientToken)).expect(200);
    assert.deepEqual(active.body.prescriptions.map((p) => p.id), [created.body.prescription.id]);
    await api()
      .patch(`/api/prescriptions/${created.body.prescription.id}`)
      .set(bearer(ctx.doctorToken))
      .send({ status: "discontinued" })
      .expect(200);
    const stillActive = await api().get("/api/prescriptions?status=active").set(bearer(ctx.patientToken)).expect(200);
    assert.equal(stillActive.body.prescriptions.length, 0);

    const draft = await api()
      .post("/api/medical-records")
      .set(bearer(ctx.doctorToken))
      .send({ patientId: pid, type: "Blood Work", results: "Elevated glucose", status: "preliminary" })
      .expect(201);
    const recordUrl = `/api/medical-records/${draft.body.medicalRecord.id}`;
    await api()
      .patch(recordUrl)
      .set(bearer(ctx.doctorToken))
      .send({ recommendations: "Adjust dosage", status: "final" })
      .expect(200);
    await api().patch(recordUrl).set(bearer(ctx.doctorToken)).send({ results: "changed" }).expect(409);

    const records = await api().get("/api/medical-records").set(bearer(ctx.patientToken)).expect(200);
    assert.equal(records.body.medicalRecords[0].recommendations, "Adjust dosage");
  });

  test("notifications can be marked read", async () => {
    const all = await api().get("/api/notifications").set(bearer(ctx.patientToken)).expect(200);
    assert.ok(all.body.notifications.length >= 3);
    const first = all.body.notifications[0].id;
    await api().patch(`/api/notifications/${first}/read`).set(bearer(ctx.doctorToken)).expect(404);
    await api().patch(`/api/notifications/${first}/read`).set(bearer(ctx.patientToken)).expect(200);
    const res = await api().post("/api/notifications/read-all").set(bearer(ctx.patientToken)).expect(200);
    assert.equal(res.body.updated, all.body.notifications.length - 1);
    const unread = await api().get("/api/notifications?unread=true").set(bearer(ctx.patientToken)).expect(200);
    assert.equal(unread.body.notifications.length, 0);
  });

  test("admin stats", async () => {
    await api().get("/api/admin/stats").set(bearer(ctx.doctorToken)).expect(403);
    const res = await api().get("/api/admin/stats").set(bearer(ctx.adminToken)).expect(200);
    assert.deepEqual(res.body, {
      totalDoctors: 1,
      totalNurses: 1,
      totalPatients: 2,
      pendingStaff: 0,
      activeAppointments: 2,
    });
  });

  test("disabling a user blocks them immediately", async () => {
    await api().patch(`/api/users/${ctx.doctorId}`).set(bearer(ctx.adminToken)).send({ status: "disabled" }).expect(200);
    // The Auth emulator rejects disabled users' tokens (401); in production the Firestore status check returns 403.
    const res = await api().get("/api/patients").set(bearer(ctx.doctorToken));
    assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
  });
});
