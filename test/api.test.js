// End-to-end flows of the v1 API: onboarding, approval, booking, the appointment state machine,
// clinical records and notifications (docs/domain-model.md §4).
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import {
  V1,
  api,
  as,
  bearer,
  db,
  googleUser,
  resetEmulators,
  seedDepartment,
  seedFacility,
  signIn,
  staffUser,
  ts,
  weekdaySlot,
} from "./helpers.js";

const ADMIN_EMAIL = "admin@curecloud.test";
process.env.BOOTSTRAP_ADMIN_EMAIL = ADMIN_EMAIL;

describe("CureCloud API v1", () => {
  const ctx = {};

  before(async () => {
    await resetEmulators();
    await seedFacility("f1");
    await seedDepartment("dep-med", "f1", "General Medicine");
  });

  test("health is public and versioned; everything else needs a token", async () => {
    const health = await api().get("/api/health").expect(200);
    assert.equal(health.body.status, "ok");
    assert.match(health.body.version, /^\d+\.\d+\.\d+/);
    assert.equal(health.headers["cache-control"], "no-store");

    const res = await api().get(`${V1}/me`).expect(401);
    assert.match(res.headers["content-type"], /application\/problem\+json/);
    assert.equal(res.body.code, "unauthenticated");
    assert.equal(res.body.type, "https://curecloud1.web.app/problems/unauthenticated");
    await api().get(`${V1}/me`).set(bearer("garbage")).expect(401);
    // The unversioned routes are gone.
    const old = await api().get("/api/me").expect(404);
    assert.equal(old.body.code, "not-found");
  });

  test("CORS allows only CureCloud origins, including DELETE", async () => {
    for (const origin of ["https://curecloud1.web.app", "https://curecloud1--pr24-abc123.web.app", "http://localhost:5173"]) {
      const pre = await api()
        .options(`${V1}/me`)
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "DELETE")
        .expect(204);
      assert.equal(pre.headers["access-control-allow-origin"], origin);
      assert.match(pre.headers["access-control-allow-methods"], /DELETE/);
    }
    const evil = "https://curecloud1.web.app.evil.com";
    await api().options(`${V1}/me`).set("Origin", evil).expect(403);
    const res = await api().get("/api/health").set("Origin", evil).expect(200);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });

  test("malformed JSON and unknown fields are problem+json 400s", async () => {
    const bad = await api().post(`${V1}/auth/signup`).set("content-type", "application/json").send("{oops").expect(400);
    assert.equal(bad.body.code, "malformed-json");
    const unknown = await api().post(`${V1}/auth/signup`).send({ email: "x@y.test", hacker: true }).expect(400);
    assert.equal(unknown.body.code, "validation-error");
    assert.ok(unknown.body.errors.some((e) => e.path === "" || e.code === "unrecognized_keys"));
  });

  test("staff signup creates a pending account and raises an alert", async () => {
    const payload = {
      email: "Dr.House@curecloud.test",
      password: "password123",
      name: "Gregory House",
      identifier: { type: "za-id", value: "8001015009087" },
      role: "doctor",
      phone: "082 555 0101",
      licenceNumber: "MP0654321",
      specialization: "Diagnostics",
    };
    const res = await api().post(`${V1}/auth/signup`).send(payload).expect(201);
    assert.deepEqual(res.body, { id: res.body.id, status: "pending" });
    assert.equal(res.headers.location, `/api/v1/users/${res.body.id}`);
    ctx.doctorId = res.body.id;

    const stored = (await db.collection("users").doc(ctx.doctorId).get()).data();
    assert.equal(stored.phone, "+27825550101");
    assert.equal(stored.practitioner.licenceBody, "hpcsa");
    assert.equal(stored.schemaVersion, 2);

    const dup = await api().post(`${V1}/auth/signup`).send(payload).expect(409);
    assert.equal(dup.body.code, "conflict");
    await api().post(`${V1}/auth/signup`).send({ ...payload, email: "x@curecloud.test", role: "admin" }).expect(400);
    const badId = await api()
      .post(`${V1}/auth/signup`)
      .send({ ...payload, email: "y@curecloud.test", identifier: { type: "za-id", value: "8001015009088" } })
      .expect(400);
    assert.equal(badId.body.errors[0].path, "identifier.value");

    ctx.doctorToken = await signIn("dr.house@curecloud.test");
    const blocked = await as(ctx.doctorToken).get("/patients").expect(403);
    assert.equal(blocked.body.code, "account-pending");
    const me = await as(ctx.doctorToken).get("/me").expect(200);
    assert.equal(me.body.user.status, "pending");
    assert.deepEqual(me.body.permissions, []);
  });

  test("first Google sign-in creates a patient profile", async () => {
    const { uid, token } = await googleUser("thandi@gmail.test", "Thandi Mokoena");
    ctx.patientUid = uid;
    ctx.patientToken = token;

    const missing = await as(token).get("/me").expect(404);
    assert.equal(missing.body.code, "not-found");
    const noProfile = await as(token).get("/appointments").expect(403);
    assert.equal(noProfile.body.code, "profile-required");

    const created = await as(token).post("/me", { birthDate: "1990-05-04", phone: "0821234567", sex: "female" }).expect(201);
    assert.equal(created.body.user.role, "patient");
    assert.equal(created.body.user.name, "Thandi Mokoena");
    assert.equal(created.body.user.phone, null); // patient contact data lives on the Patient
    assert.equal(created.body.patient.phone, "+27821234567");
    assert.equal(created.body.patient.email, "thandi@gmail.test");
    assert.equal(created.body.patient.userId, uid);
    assert.ok(created.body.permissions.includes("appointment:create"));
    assert.ok(!created.body.permissions.includes("patient:list"));
    ctx.patientId = created.body.patient.id;
    await as(token).post("/me", {}).expect(409);
  });

  test("bootstrap admin approves staff", async () => {
    const { uid, token } = await googleUser(ADMIN_EMAIL, "Site Admin");
    ctx.adminId = uid;
    ctx.adminToken = token;
    const created = await as(token).post("/me", {}).expect(201);
    assert.equal(created.body.user.role, "admin");
    assert.equal(created.body.user.facilityId, null);
    assert.equal(created.body.patient, null);

    const pending = await as(token).get("/users?status=pending").expect(200);
    assert.deepEqual(pending.body.data.map((u) => u.id), [ctx.doctorId]);
    assert.equal(pending.body.nextCursor, null);
    assert.ok("lastSignInAt" in pending.body.data[0]);

    const alerts = await as(token).get("/system-alerts?status=active").expect(200);
    assert.equal(alerts.body.data.length, 1);
    assert.deepEqual(alerts.body.data[0].resource, { type: "user", id: ctx.doctorId });

    await as(ctx.patientToken).get("/users").expect(403);
    // Activation requires a facility.
    const noFacility = await as(token).patch(`/users/${ctx.doctorId}`, { status: "active" }).expect(400);
    assert.match(noFacility.body.detail, /facilityId/);
    const approved = await as(token)
      .patch(`/users/${ctx.doctorId}`, { status: "active", facilityId: "f1", departmentId: "dep-med" })
      .expect(200);
    assert.equal(approved.body.status, "active");

    const resolved = await as(token).get("/system-alerts?status=active").expect(200);
    assert.equal(resolved.body.data.length, 0);
    const notes = await as(ctx.doctorToken).get("/notifications").expect(200);
    assert.equal(notes.body.data[0].title, "Account approved");
  });

  test("patients see the doctor directory without email", async () => {
    const res = await as(ctx.patientToken).get("/practitioners").expect(200);
    assert.deepEqual(res.body.data, [
      {
        id: ctx.doctorId,
        name: "Gregory House",
        role: "doctor",
        specialization: "Diagnostics",
        photoUrl: null,
        facilityId: "f1",
        facilityName: "Chris Hani Baragwanath",
        departmentId: "dep-med",
        departmentName: "General Medicine",
      },
    ]);
    const staffView = await as(ctx.doctorToken).get("/practitioners?role=doctor").expect(200);
    assert.equal(staffView.body.data[0].email, "dr.house@curecloud.test");
    await as(ctx.patientToken).get("/practitioners?role=nurse").expect(403);
  });

  test("patient books an appointment; double-booking and bad times are rejected", async () => {
    const booking = { doctorId: ctx.doctorId, start: weekdaySlot(3, "09:30"), type: "follow-up", reason: "Sugar levels" };
    const res = await as(ctx.patientToken).post("/appointments", booking).expect(201);
    assert.equal(res.body.status, "pending");
    assert.equal(res.body.patientName, "Thandi Mokoena");
    assert.equal(res.body.doctorName, "Gregory House");
    assert.equal(res.body.durationMinutes, 30);
    assert.equal(res.body.facilityId, "f1");
    assert.equal(new Date(res.body.end) - new Date(res.body.start), 30 * 60e3);
    assert.equal(res.body.reason, "Sugar levels");
    ctx.appointmentId = res.body.id;
    ctx.booking = booking;

    const taken = await as(ctx.patientToken).post("/appointments", booking).expect(409);
    assert.equal(taken.body.code, "slot-unavailable");
    // Overlapping the second 15-minute unit is also taken.
    const overlap = await as(ctx.patientToken)
      .post("/appointments", { ...booking, start: weekdaySlot(3, "09:45"), durationMinutes: 15 })
      .expect(409);
    assert.equal(overlap.body.code, "slot-unavailable");
    await as(ctx.patientToken).post("/appointments", { ...booking, start: "2020-01-06T09:00:00+02:00" }).expect(400);
    await as(ctx.patientToken).post("/appointments", { ...booking, start: weekdaySlot(3, "09:10") }).expect(400);
    const noOffset = await as(ctx.patientToken).post("/appointments", { ...booking, start: "2030-01-07T09:00:00" }).expect(400);
    assert.equal(noOffset.body.errors[0].path, "start");
    const closed = await as(ctx.patientToken).post("/appointments", { ...booking, start: weekdaySlot(3, "17:00") }).expect(409);
    assert.equal(closed.body.code, "slot-unavailable");
    await as(ctx.patientToken).post("/appointments", { ...booking, doctorId: ctx.adminId }).expect(404);
  });

  test("booking adds the doctor to the care team, sets the facility and notifies", async () => {
    const patients = await as(ctx.doctorToken).get("/patients").expect(200);
    assert.deepEqual(patients.body.data.map((p) => p.id), [ctx.patientId]);
    assert.equal(patients.body.data[0].facilityId, "f1");
    assert.equal(patients.body.data[0].identifier, undefined);

    const appts = await as(ctx.doctorToken).get(`/appointments?from=${encodeURIComponent(new Date().toISOString())}`).expect(200);
    assert.deepEqual(appts.body.data.map((a) => a.id), [ctx.appointmentId]);
    assert.equal(appts.body.data[0].reason, "Sugar levels");

    const unread = await as(ctx.doctorToken).get("/notifications/unread-count").expect(200);
    assert.equal(unread.body.count, 2); // account approved + booking request
    const notes = await as(ctx.doctorToken).get("/notifications?unread=true").expect(200);
    assert.equal(notes.body.data[0].title, "New appointment request");
    assert.deepEqual(notes.body.data[0].resource, { type: "appointment", id: ctx.appointmentId });

    const audit = await db.collection("auditEvents").where("resource.id", "==", ctx.doctorId).where("resource.type", "==", "care-team").get();
    assert.equal(audit.size, 1);
    assert.equal(audit.docs[0].get("actorId"), ctx.patientUid);
  });

  test("appointment state machine", async () => {
    const url = `/appointments/${ctx.appointmentId}`;
    const denied = await as(ctx.patientToken).patch(url, { status: "confirmed" }).expect(403);
    assert.equal(denied.body.code, "forbidden");
    await as(ctx.patientToken).patch(url, { type: "procedure" }).expect(403);
    await as(ctx.doctorToken).patch(url, { status: "confirmed" }).expect(200);
    const early = await as(ctx.doctorToken).patch(url, { status: "completed" }).expect(409);
    assert.equal(early.body.code, "invalid-state-transition");

    const patientNotes = await as(ctx.patientToken).get("/notifications").expect(200);
    assert.match(patientNotes.body.data[0].description, /confirmed/);

    // A patient reschedule returns to pending and frees the old slot.
    const moved = await as(ctx.patientToken).patch(url, { start: weekdaySlot(4, "11:00") }).expect(200);
    assert.equal(moved.body.status, "pending");
    await as(ctx.patientToken).post("/appointments", ctx.booking).expect(201);

    await as(ctx.patientToken).patch(url, { status: "cancelled", cancellationReason: "Feeling better" }).expect(200);
    const terminal = await as(ctx.doctorToken).patch(url, { status: "confirmed" }).expect(409);
    assert.equal(terminal.body.code, "invalid-state-transition");
    await as(ctx.patientToken).post("/appointments", { ...ctx.booking, start: weekdaySlot(4, "11:00") }).expect(201);
  });

  test("check-in, completion and no-show follow the time guards", async () => {
    // Appointments in the past are written directly; booking would reject them.
    const start = new Date(Date.now() - 3600e3);
    const ref = db.collection("appointments").doc("past-appt");
    await ref.set({
      patientId: ctx.patientId,
      patientName: "Thandi Mokoena",
      patientUserId: ctx.patientUid,
      doctorId: ctx.doctorId,
      doctorName: "Gregory House",
      facilityId: "f1",
      departmentId: "dep-med",
      start: ts(start),
      end: ts(start.getTime() + 30 * 60e3),
      durationMinutes: 30,
      type: "check-up",
      reason: null,
      status: "confirmed",
      cancellationReason: null,
      cancelledBy: null,
      checkedInAt: null,
      createdAt: ts(start),
      createdBy: ctx.patientUid,
      updatedAt: ts(start),
      updatedBy: ctx.patientUid,
      schemaVersion: 2,
    });
    const checkedIn = await as(ctx.doctorToken).patch("/appointments/past-appt", { status: "checked-in" }).expect(200);
    assert.ok(checkedIn.body.checkedInAt);
    await as(ctx.adminToken).patch("/appointments/past-appt", { status: "completed" }).expect(403);
    await as(ctx.doctorToken).patch("/appointments/past-appt", { status: "completed" }).expect(200);
    const cancel = await as(ctx.patientToken).patch("/appointments/past-appt", { status: "cancelled" }).expect(409);
    assert.equal(cancel.body.code, "invalid-state-transition");
  });

  test("vitals, prescriptions and medical records", async () => {
    const pid = ctx.patientId;
    const doctor = as(ctx.doctorToken);
    await doctor.post(`/patients/${pid}/vitals`, { bloodPressure: { systolic: 120, diastolic: 80 }, heartRate: 72 }).expect(201);
    const second = await doctor.post(`/patients/${pid}/vitals`, { weight: 68.25, bloodGlucose: 5.4 }).expect(201);
    assert.equal(second.body.weight, 68.3);
    await doctor.post(`/patients/${pid}/vitals`, { heartRate: 900 }).expect(400);
    await doctor.post(`/patients/${pid}/vitals`, { bloodPressure: { systolic: 80, diastolic: 120 } }).expect(400);
    await doctor.post(`/patients/${pid}/vitals`, {}).expect(400);
    await as(ctx.patientToken).post(`/patients/${pid}/vitals`, { weight: 60 }).expect(403);

    const me = await as(ctx.patientToken).get("/me").expect(200);
    assert.deepEqual(me.body.patient.latestVitals.bloodPressure, { systolic: 120, diastolic: 80 });
    assert.equal(me.body.patient.latestVitals.weight, 68.3);
    const history = await as(ctx.patientToken).get(`/patients/${pid}/vitals`).expect(200);
    assert.equal(history.body.data.length, 2);

    // Retracting a panel rebuilds latestVitals.
    await doctor.patch(`/patients/${pid}/vitals/${second.body.id}`, { status: "entered-in-error", statusReason: "Wrong patient" }).expect(200);
    const after = await as(ctx.patientToken).get("/me").expect(200);
    assert.equal(after.body.patient.latestVitals.weight, undefined);
    assert.equal((await as(ctx.patientToken).get(`/patients/${pid}/vitals`).expect(200)).body.data.length, 1);
    await as(ctx.patientToken).get(`/patients/${pid}/vitals?status=entered-in-error`).expect(403);
    assert.equal((await doctor.get(`/patients/${pid}/vitals?status=entered-in-error`).expect(200)).body.data.length, 1);

    const rx = { patientId: pid, medication: "Metformin", dose: "500 mg", frequency: "twice-daily", startDate: "2026-10-01", refills: 2 };
    const bad = await doctor.post("/prescriptions", { ...rx, endDate: "2026-01-01" }).expect(400);
    assert.equal(bad.body.errors[0].path, "endDate");
    await doctor.post("/prescriptions", { ...rx, frequency: "custom" }).expect(400);
    const created = await doctor.post("/prescriptions", rx).expect(201);
    assert.deepEqual(created.body.administrationTimes, ["08:00", "20:00"]);
    assert.equal(created.body.category, "outpatient");
    assert.equal(created.body.route, "oral");
    const active = await as(ctx.patientToken).get("/prescriptions?status=active").expect(200);
    assert.deepEqual(active.body.data.map((p) => p.id), [created.body.id]);

    const rxUrl = `/prescriptions/${created.body.id}`;
    await doctor.patch(rxUrl, { status: "on-hold" }).expect(400); // statusReason required
    await doctor.patch(rxUrl, { status: "stopped", statusReason: "Side effects" }).expect(200);
    const immutable = await doctor.patch(rxUrl, { refills: 1 }).expect(409);
    assert.equal(immutable.body.code, "record-immutable");
    await doctor.patch(rxUrl, { status: "active" }).expect(409);
    assert.equal((await as(ctx.patientToken).get("/prescriptions?status=active").expect(200)).body.data.length, 0);

    const draft = await doctor
      .post("/medical-records", { patientId: pid, category: "lab-result", title: "Blood work", findings: "Elevated glucose", status: "preliminary" })
      .expect(201);
    // Patients do not see preliminary records.
    assert.equal((await as(ctx.patientToken).get("/medical-records").expect(200)).body.data.length, 0);
    await as(ctx.patientToken).get(`/medical-records/${draft.body.id}`).expect(404);

    const recordUrl = `/medical-records/${draft.body.id}`;
    await doctor.patch(recordUrl, { recommendations: "Adjust dosage", status: "final" }).expect(200);
    const locked = await doctor.patch(recordUrl, { findings: "changed" }).expect(409);
    assert.equal(locked.body.code, "record-immutable");
    const amended = await doctor.post(`${recordUrl}/addenda`, { text: "Repeat in 3 months" }).expect(201);
    assert.equal(amended.body.status, "amended");
    assert.equal(amended.body.addenda.length, 1);

    const records = await as(ctx.patientToken).get("/medical-records").expect(200);
    assert.equal(records.body.data[0].recommendations, "Adjust dosage");
    const notes = await as(ctx.patientToken).get("/notifications").expect(200);
    const recordNote = notes.body.data.find((n) => n.type === "medical-record");
    assert.equal(recordNote.title, "New medical record: Blood work");
    assert.doesNotMatch(recordNote.description, /glucose/i);
  });

  test("notifications can be marked read; lists paginate with cursors", async () => {
    const all = await as(ctx.patientToken).get("/notifications").expect(200);
    assert.ok(all.body.data.length >= 3);
    const first = all.body.data[0].id;
    await as(ctx.doctorToken).patch(`/notifications/${first}`, { read: true }).expect(404);
    const read = await as(ctx.patientToken).patch(`/notifications/${first}`, { read: true }).expect(200);
    assert.ok(read.body.readAt);

    const page1 = await as(ctx.patientToken).get("/notifications?limit=2").expect(200);
    assert.equal(page1.body.data.length, 2);
    assert.ok(page1.body.nextCursor);
    const page2 = await as(ctx.patientToken).get(`/notifications?limit=2&cursor=${page1.body.nextCursor}`).expect(200);
    assert.ok(!page2.body.data.some((n) => page1.body.data.some((m) => m.id === n.id)));
    const badCursor = await as(ctx.patientToken).get("/notifications?cursor=bm9wZQ").expect(400);
    assert.equal(badCursor.body.code, "invalid-cursor");
    const foreignCursor = Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url");
    await as(ctx.patientToken).get(`/notifications?cursor=${foreignCursor}`).expect(400);

    const res = await as(ctx.patientToken).post("/notifications/read-all").expect(200);
    assert.equal(res.body.updated, all.body.data.length - 1);
    assert.equal((await as(ctx.patientToken).get("/notifications/unread-count").expect(200)).body.count, 0);
  });

  test("admin dashboard", async () => {
    await as(ctx.doctorToken).get("/admin/stats").expect(404);
    const res = await as(ctx.adminToken).get("/dashboard").expect(200);
    assert.equal(res.body.role, "admin");
    assert.equal(res.body.counters.doctors, 1);
    assert.equal(res.body.counters.patients, 1);
    assert.equal(res.body.counters.pendingStaff, 0);
    assert.equal(res.body.counters.upcomingAppointments, 2);
    const doctor = await as(ctx.doctorToken).get("/dashboard").expect(200);
    assert.equal(doctor.body.role, "doctor");
    assert.equal(doctor.body.counters.patients, 1);
    assert.equal(doctor.body.counters.activePrescriptions, 0);
  });

  test("disabling a user blocks them immediately", async () => {
    await as(ctx.adminToken).patch(`/users/${ctx.doctorId}`, { status: "disabled", statusReason: "Left" }).expect(200);
    // The Auth emulator rejects disabled users' tokens (401); in production the status check returns 403.
    const res = await as(ctx.doctorToken).get("/patients");
    assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
  });

  test("staff accounts can be created directly for other suites", async () => {
    const nurse = await staffUser("nurse.check@curecloud.test", "nurse", { facilityId: "f1", departmentId: "dep-med" });
    const me = await as(nurse.token).get("/me").expect(200);
    assert.equal(me.body.user.practitioner.licenceBody, "sanc");
  });
});
