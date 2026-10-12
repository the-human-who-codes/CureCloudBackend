// The endpoints added in v1 (docs/domain-model.md §4.2): organisation, care team and admission,
// care tasks, shifts, the medication schedule, conversations, settings, alerts, dashboards and reports.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { as, audit, db, googleUser, resetEmulators, sastDay, seedDepartment, seedFacility, staffUser, weekdaySlot } from "./helpers.js";

describe("v1 resources", () => {
  const u = {};
  const ids = {};

  before(async () => {
    await resetEmulators();
    await seedFacility("f1");
    await seedFacility("f2", "Groote Schuur");
    await seedDepartment("ward1", "f1", "Ward 1", 4);
    u.sys = await staffUser("sys@curecloud.test", "admin", { name: "System Admin" });
    u.admin = await staffUser("admin@curecloud.test", "admin", { name: "Facility Admin", facilityId: "f1" });
    u.d1 = await staffUser("d1@curecloud.test", "doctor", { name: "Doctor One", facilityId: "f1", departmentId: "ward1" });
    u.n1 = await staffUser("n1@curecloud.test", "nurse", { name: "Nurse One", facilityId: "f1", departmentId: "ward1" });
    u.n2 = await staffUser("n2@curecloud.test", "nurse", { name: "Nurse Two", facilityId: "f1", departmentId: "ward1" });
    u.p = await googleUser("p@gmail.test", "Patient Pat");
    ids.p = (await as(u.p.token).post("/me", {}).expect(201)).body.patient.id;
  });

  describe("organisation", () => {
    test("facilities are readable by everyone", async () => {
      const res = await as(u.p.token).get("/facilities").expect(200);
      assert.deepEqual(res.body.data.map((f) => f.name), ["Chris Hani Baragwanath", "Groote Schuur"]);
    });

    test("departments: create, unique names, head, stats and archive", async () => {
      const created = await as(u.admin.token).post("/departments", { name: "Cardiology", bedCapacity: 10, headId: u.d1.uid }).expect(201);
      assert.equal(created.body.facilityId, "f1");
      assert.equal(created.body.headName, "Doctor One");
      ids.cardio = created.body.id;
      const dup = await as(u.admin.token).post("/departments", { name: "cardiology", bedCapacity: 1 }).expect(409);
      assert.equal(dup.body.code, "conflict");
      await as(u.admin.token).post("/departments", { name: "Elsewhere", bedCapacity: 1, facilityId: "f2" }).expect(403);
      ids.trauma = (await as(u.sys.token).post("/departments", { name: "Trauma", bedCapacity: 8, facilityId: "f2" }).expect(201)).body.id;
      await as(u.sys.token).post("/departments", { name: "Nowhere", bedCapacity: 8 }).expect(400); // system admins name the facility
      // facilityId is immutable after create.
      const move = await as(u.admin.token).patch(`/departments/${ids.cardio}`, { facilityId: "f2" }).expect(400);
      assert.equal(move.body.code, "validation-error");

      const list = await as(u.n1.token).get("/departments").expect(200);
      assert.deepEqual(list.body.data.map((d) => d.name), ["Cardiology", "Ward 1"]);
      await as(u.n1.token).get("/departments?include=stats").expect(403);
      await as(u.n1.token).get("/departments?facilityId=f2").expect(403);
      const stats = await as(u.admin.token).get("/departments?include=stats").expect(200);
      const ward = stats.body.data.find((d) => d.id === "ward1");
      assert.deepEqual(ward.stats, { staff: 3, doctors: 1, nurses: 2, admittedPatients: 0, occupancyRate: 0, appointmentsToday: 0 });

      await as(u.admin.token).patch(`/departments/${ids.cardio}`, { status: "archived" }).expect(200);
      assert.equal((await as(u.n1.token).get("/departments").expect(200)).body.data.length, 1);
    });
  });

  describe("patients, care team and admission", () => {
    test("walk-in registration and care team management", async () => {
      const w = await as(u.admin.token).post("/patients", { name: "Sipho Dlamini", folderNumber: "BH-0042", sex: "male" }).expect(201);
      ids.w = w.body.id;
      assert.equal(w.body.careTeam.length, 0);
      assert.equal(w.body.facilityId, "f1");
      assert.equal(w.headers.location, `/api/v1/patients/${ids.w}`);
      await as(u.d1.token).get(`/patients/${ids.w}`).expect(404);

      await as(u.admin.token).post(`/patients/${ids.w}/care-team`, { userId: u.p.uid }).expect(400);
      const team = await as(u.admin.token).post(`/patients/${ids.w}/care-team`, { userId: u.d1.uid }).expect(201);
      assert.deepEqual(team.body.data.map((m) => m.name), ["Doctor One"]);
      const notes = await as(u.d1.token).get("/notifications").expect(200);
      assert.equal(notes.body.data[0].title, "Added to a care team");
      // Doctors on the care team may add colleagues.
      await as(u.d1.token).post(`/patients/${ids.w}/care-team`, { userId: u.n2.uid }).expect(201);
      const read = await as(u.d1.token).get(`/patients/${ids.w}/care-team`).expect(200);
      assert.equal(read.body.data.length, 2);
      await as(u.admin.token).delete(`/patients/${ids.w}/care-team/${u.n2.uid}`).expect(204);
      await as(u.admin.token).delete(`/patients/${ids.w}/care-team/${u.n2.uid}`).expect(404);
    });

    test("admit, transfer within the department and discharge", async () => {
      await as(u.d1.token).post(`/patients/${ids.w}/admission`, { departmentId: "ward9" }).expect(400);
      const admitted = await as(u.d1.token)
        .post(`/patients/${ids.w}/admission`, { departmentId: "ward1", ward: "Ward 1", room: "3", bed: "A", attendingDoctorId: u.d1.uid })
        .expect(201);
      assert.equal(admitted.body.admission.departmentName, "Ward 1");
      assert.equal(admitted.body.admission.admittedBy, u.d1.uid);
      const again = await as(u.d1.token).post(`/patients/${ids.w}/admission`, { departmentId: "ward1" }).expect(409);
      assert.equal(again.body.code, "conflict");
      // Ward nurses can see and move admitted patients within their department.
      const moved = await as(u.n1.token).patch(`/patients/${ids.w}/admission`, { room: "4" }).expect(200);
      assert.equal(moved.body.admission.room, "4");
    });
  });

  describe("care tasks", () => {
    test("create, claim, start, complete and list", async () => {
      const due = new Date(Date.now() + 3600e3).toISOString();
      const created = await as(u.d1.token)
        .post("/care-tasks", { patientId: ids.w, title: "Hourly obs", category: "vitals", priority: "high", dueAt: due })
        .expect(201);
      assert.equal(created.body.departmentId, "ward1");
      assert.equal(created.body.status, "open");
      ids.task = created.body.id;
      await as(u.d1.token).post("/care-tasks", { title: "X", category: "other", dueAt: due, assigneeId: u.d1.uid }).expect(400);

      const unassigned = await as(u.n1.token).get("/care-tasks?assigneeId=unassigned").expect(200);
      assert.deepEqual(unassigned.body.data.map((t) => t.id), [ids.task]);
      const started = await as(u.n1.token).patch(`/care-tasks/${ids.task}`, { status: "in-progress" }).expect(200);
      assert.equal(started.body.assigneeId, u.n1.uid); // starting claims the task
      assert.ok(started.body.startedAt);
      const mine = await as(u.n1.token).get("/care-tasks?assigneeId=me").expect(200);
      assert.equal(mine.body.data.length, 1);
      const byColleague = await as(u.n2.token).get(`/care-tasks?assigneeId=${u.n1.uid}`).expect(200);
      assert.equal(byColleague.body.data.length, 1);

      await as(u.n1.token).patch(`/care-tasks/${ids.task}`, { status: "cancelled" }).expect(403);
      const done = await as(u.n1.token).patch(`/care-tasks/${ids.task}`, { status: "completed", completionNote: "All normal" }).expect(200);
      assert.equal(done.body.completedBy, u.n1.uid);
      const terminal = await as(u.n1.token).patch(`/care-tasks/${ids.task}`, { title: "Edit" }).expect(409);
      assert.equal(terminal.body.code, "record-immutable");
      const today = await as(u.n1.token).get(`/care-tasks?completedBy=me&completedAfter=${encodeURIComponent(new Date(Date.now() - 86400e3).toISOString())}`).expect(200);
      assert.deepEqual(today.body.data.map((t) => t.id), [ids.task]);

      // Ward-level tasks name their department; nurses only their own.
      const assigned = await as(u.n1.token)
        .post("/care-tasks", { title: "Check crash trolley", category: "admin", dueAt: due, departmentId: "ward1", assigneeId: u.n2.uid })
        .expect(201);
      assert.equal(assigned.body.patientId, null);
      const notes = await as(u.n2.token).get("/notifications").expect(200);
      assert.ok(notes.body.data.some((n) => n.resource?.id === assigned.body.id));
      await as(u.n1.token).post("/care-tasks", { title: "Elsewhere", category: "admin", dueAt: due, departmentId: ids.trauma }).expect(403);
      // Patient tasks take their department from the admission and need a clinical assignee.
      const both = await as(u.d1.token).post("/care-tasks", { patientId: ids.w, departmentId: "ward1", title: "X", category: "other", dueAt: due }).expect(400);
      assert.equal(both.body.errors[0].path, "departmentId");
      await as(u.d1.token).post("/care-tasks", { patientId: ids.w, title: "X", category: "other", dueAt: due, assigneeId: u.admin.uid }).expect(403);
    });

    test("patient tasks need clinical access to the patient, not just the department", async () => {
      const due = new Date(Date.now() + 3600e3).toISOString();
      // An outpatient on Doctor One's care team: the task has no department.
      const out = await as(u.d1.token).post("/patients", { name: "Lindiwe Outpatient" }).expect(201);
      const task = await as(u.d1.token).post("/care-tasks", { patientId: out.body.id, title: "Phone with results", category: "other", dueAt: due }).expect(201);
      assert.equal(task.body.departmentId, null);
      await as(u.n1.token).get(`/care-tasks/${task.body.id}`).expect(404);
      await as(u.n1.token).patch(`/care-tasks/${task.body.id}`, { status: "in-progress" }).expect(404);
      await as(u.d1.token).get(`/care-tasks/${task.body.id}`).expect(200);
      await as(u.d1.token).post("/care-tasks", { patientId: out.body.id, title: "Y", category: "other", dueAt: due, assigneeId: u.n1.uid }).expect(403);
    });
  });

  describe("shifts", () => {
    test("roster, overlap, handover and current shift", async () => {
      const now = Date.now();
      const iso = (ms) => new Date(ms).toISOString();
      // A finished shift with a handover note, then the current one.
      const prev = await as(u.admin.token).post("/shifts", { staffId: u.n2.uid, type: "night", start: iso(now - 14 * 3600e3), end: iso(now - 2 * 3600e3) }).expect(201);
      await as(u.n2.token).patch(`/shifts/${prev.body.id}`, { handoverNote: "Bed 3A needs 2-hourly obs" }).expect(200);
      await as(u.n1.token).patch(`/shifts/${prev.body.id}`, { handoverNote: "Not mine" }).expect(403);
      const current = await as(u.admin.token).post("/shifts", { staffId: u.n1.uid, type: "day", start: iso(now - 2 * 3600e3), end: iso(now + 6 * 3600e3) }).expect(201);
      const overlap = await as(u.admin.token).post("/shifts", { staffId: u.n1.uid, type: "on-call", start: iso(now), end: iso(now + 3600e3) }).expect(409);
      assert.equal(overlap.body.code, "conflict");
      await as(u.admin.token).post("/shifts", { staffId: u.n1.uid, type: "day", start: iso(now), end: iso(now + 25 * 3600e3) }).expect(400);
      await as(u.admin.token).post("/shifts", { staffId: u.p.uid, type: "day", start: iso(now + 48 * 3600e3), end: iso(now + 50 * 3600e3) }).expect(400);

      const mine = await as(u.n1.token).get("/shifts/current").expect(200);
      assert.equal(mine.body.shift.id, current.body.id);
      assert.equal(mine.body.previousHandover.note, "Bed 3A needs 2-hourly obs");
      assert.equal(mine.body.previousHandover.staffName, "Nurse Two");
      assert.deepEqual(mine.body.onDuty.map((d) => d.staffName), ["Nurse One"]);
      const adminView = await as(u.admin.token).get("/shifts/current").expect(200);
      assert.equal(adminView.body.previousHandover, null);

      const roster = await as(u.admin.token).get(`/shifts?from=${encodeURIComponent(iso(now - 86400e3))}&to=${encodeURIComponent(iso(now + 86400e3))}`).expect(200);
      assert.equal(roster.body.data.length, 2);
      assert.ok(roster.body.data.every((s) => s.handoverNote === undefined)); // never to admins
      const nurseRoster = await as(u.n1.token).get(`/shifts?departmentId=ward1&from=${encodeURIComponent(iso(now - 86400e3))}`).expect(200);
      assert.equal(nurseRoster.body.data.find((s) => s.id === prev.body.id).handoverNote, "Bed 3A needs 2-hourly obs");
      await as(u.n1.token).get(`/shifts?from=${encodeURIComponent(iso(now))}&to=${encodeURIComponent(iso(now + 40 * 86400e3))}`).expect(400);

      // System admins name a facility or department; handover notes are never written by admins.
      await as(u.sys.token).get("/shifts").expect(400);
      assert.equal((await as(u.sys.token).get(`/shifts?facilityId=f1&from=${encodeURIComponent(iso(now - 86400e3))}`).expect(200)).body.data.length, 2);
      await as(u.admin.token).get("/shifts?facilityId=f1").expect(403);
      await as(u.admin.token).patch(`/shifts/${prev.body.id}`, { handoverNote: "Admin note" }).expect(403);
      const own = await as(u.sys.token).post("/shifts", { staffId: u.admin.uid, type: "day", start: iso(now + 72 * 3600e3), end: iso(now + 80 * 3600e3) }).expect(201);
      await as(u.admin.token).patch(`/shifts/${own.body.id}`, { handoverNote: "My own" }).expect(403);
      const handoverAudit = await db.collection("auditEvents").where("resource.id", "==", prev.body.id).get();
      assert.ok(handoverAudit.docs.some((d) => d.get("changedFields").includes("handoverNote")));

      await as(u.admin.token).patch(`/shifts/${current.body.id}`, { status: "cancelled" }).expect(200);
      await as(u.admin.token).patch(`/shifts/${current.body.id}`, { type: "night" }).expect(409);
      await as(u.n1.token).patch(`/shifts/${current.body.id}`, { status: "cancelled" }).expect(403);
    });
  });

  describe("medication schedule and administration", () => {
    test("scheduled doses, charting once, PRN and retraction", async () => {
      const today = sastDay();
      const rx = await as(u.d1.token)
        .post("/prescriptions", {
          patientId: ids.w,
          medication: "Ceftriaxone",
          dose: "1 g",
          route: "iv",
          frequency: "custom",
          frequencyText: "Every 12 hours",
          administrationTimes: ["00:00", "12:00"],
          startDate: sastDay(-1),
        })
        .expect(201);
      assert.equal(rx.body.category, "inpatient"); // the patient is admitted
      await as(u.d1.token).post("/prescriptions", { patientId: ids.w, medication: "Paracetamol", dose: "1 g", frequency: "as-needed", startDate: sastDay(-1) }).expect(201);

      const schedule = await as(u.n1.token).get(`/medication-schedule?date=${today}`).expect(200);
      assert.equal(schedule.body.data.length, 2);
      assert.equal(schedule.body.data[0].patientName, "Sipho Dlamini");
      assert.equal(schedule.body.data[0].room, "4");
      assert.equal(schedule.body.prn.length, 1);
      const midnight = schedule.body.data[0];
      assert.equal(midnight.scheduledFor, new Date(`${today}T00:00:00+02:00`).toISOString());
      assert.ok(["overdue", "due"].includes(midnight.status));

      await as(u.n1.token).post("/medication-administrations", { prescriptionId: rx.body.id, scheduledFor: `${today}T03:00:00+02:00`, status: "completed" }).expect(400);
      const given = await as(u.n1.token)
        .post("/medication-administrations", { prescriptionId: rx.body.id, scheduledFor: midnight.scheduledFor, status: "completed" })
        .expect(201);
      const lockRef = db.collection("administrationSlots").doc(`${rx.body.id}_${new Date(midnight.scheduledFor).getTime()}`);
      assert.equal((await lockRef.get()).get("administrationId"), given.body.id);
      const twice = await as(u.n2.token)
        .post("/medication-administrations", { prescriptionId: rx.body.id, scheduledFor: midnight.scheduledFor, status: "not-done", statusReason: "patient-refused" })
        .expect(409);
      assert.equal(twice.body.code, "already-charted");
      await as(u.n1.token).post("/medication-administrations", { prescriptionId: rx.body.id, status: "not-done", scheduledFor: midnight.scheduledFor }).expect(400);

      const after = await as(u.n1.token).get(`/medication-schedule?date=${today}`).expect(200);
      assert.equal(after.body.data[0].status, "given");
      assert.equal(after.body.data[0].administrationId, given.body.id);

      await as(u.n2.token).patch(`/medication-administrations/${given.body.id}`, { status: "entered-in-error", statusReason: "Wrong" }).expect(403);
      await as(u.n1.token).patch(`/medication-administrations/${given.body.id}`, { status: "entered-in-error", statusReason: "Charted on the wrong patient" }).expect(200);
      // Retracting releases the lock, so the dose is uncharted again until it is re-charted.
      assert.equal((await lockRef.get()).exists, false);
      const retracted = await as(u.n1.token).get(`/medication-schedule?date=${today}`).expect(200);
      assert.ok(["due", "overdue", "upcoming"].includes(retracted.body.data[0].status));
      assert.equal(retracted.body.data[0].administrationId, undefined);
      await as(u.n1.token).patch(`/medication-administrations/${given.body.id}`, { status: "entered-in-error", statusReason: "Again" }).expect(409);
      const recharted = await as(u.n1.token)
        .post("/medication-administrations", { prescriptionId: rx.body.id, scheduledFor: midnight.scheduledFor, status: "completed" })
        .expect(201);
      assert.notEqual(recharted.body.id, given.body.id);
      const final = await as(u.n1.token).get(`/medication-schedule?date=${today}`).expect(200);
      assert.equal(final.body.data[0].administrationId, recharted.body.id);
      assert.equal(final.body.data[0].status, "given");
      await as(u.n1.token).get(`/medication-schedule?departmentId=ward1`).expect(200);
      await as(u.d1.token).get(`/medication-schedule?departmentId=ward1`).expect(403); // nurses only
      // Nurses list prescriptions per clinical patient only.
      await as(u.n1.token).get("/prescriptions").expect(400);
      await as(u.n1.token).get(`/prescriptions?patientId=${ids.w}`).expect(200);

      const history = await as(u.n1.token).get("/medication-administrations?performerId=me").expect(200);
      assert.deepEqual(history.body.data.map((a) => a.id), [recharted.body.id]);
      const all = await as(u.d1.token).get(`/medication-administrations?prescriptionId=${rx.body.id}&status=completed,entered-in-error`).expect(200);
      assert.equal(all.body.data.length, 2);
      await as(u.n1.token).get("/medication-administrations").expect(400);

      // entered-in-error is not allowed once a dose was given.
      const blocked = await as(u.d1.token).patch(`/prescriptions/${rx.body.id}`, { status: "entered-in-error", statusReason: "x" }).expect(409);
      assert.equal(blocked.body.code, "invalid-state-transition");
    });

    test("refill requests for current outpatient prescriptions", async () => {
      const rx = await as(u.d1.token).post("/prescriptions", { patientId: ids.p, medication: "Amlodipine", dose: "5 mg", frequency: "once-daily", startDate: sastDay(-5), refills: 1 });
      assert.equal(rx.status, 404); // Pat is not on Doctor One's care team yet
      await db.collection("patients").doc(ids.p).update({ careTeam: [u.d1.uid] });
      const ok = await as(u.d1.token).post("/prescriptions", { patientId: ids.p, medication: "Amlodipine", dose: "5 mg", frequency: "once-daily", startDate: sastDay(-5), refills: 1 }).expect(201);
      assert.equal(ok.body.category, "outpatient");
      await as(u.d1.token).post(`/prescriptions/${ok.body.id}/refill-requests`, {}).expect(403);
      const res = await as(u.p.token).post(`/prescriptions/${ok.body.id}/refill-requests`, { note: "Running low" }).expect(202);
      assert.deepEqual(res.body, { status: "requested" });
      const notes = await as(u.d1.token).get("/notifications").expect(200);
      assert.equal(notes.body.data[0].title, "Refill requested");
      const none = await as(u.d1.token).post("/prescriptions", { patientId: ids.p, medication: "X", dose: "1", frequency: "once-daily", startDate: sastDay(-5) }).expect(201);
      await as(u.p.token).post(`/prescriptions/${none.body.id}/refill-requests`, {}).expect(409);
    });
  });

  describe("conversations", () => {
    test("direct (deduplicated), group and channels", async () => {
      const direct = await as(u.n1.token).post("/conversations", { type: "direct", participantIds: [u.d1.uid] }).expect(201);
      assert.equal(direct.body.id, `direct_${[u.n1.uid, u.d1.uid].sort().join("_")}`);
      const again = await as(u.d1.token).post("/conversations", { type: "direct", participantIds: [u.n1.uid] }).expect(200);
      assert.equal(again.body.id, direct.body.id);
      await as(u.n1.token).post("/conversations", { type: "direct", participantIds: [u.p.uid] }).expect(403);
      await as(u.n1.token).post("/conversations", { type: "group", participantIds: [u.d1.uid, u.n2.uid] }).expect(400); // title
      const group = await as(u.n1.token).post("/conversations", { type: "group", title: "Ward 1 team", participantIds: [u.d1.uid, u.n2.uid] }).expect(201);
      await as(u.n2.token).patch(`/conversations/${group.body.id}`, { title: "Ward 1" }).expect(200);
      await as(u.n2.token).patch(`/conversations/${group.body.id}`, { status: "archived" }).expect(403);

      await as(u.n1.token).post("/conversations", { type: "channel", title: "General" }).expect(403);
      const channel = await as(u.admin.token).post("/conversations", { type: "channel", title: "Announcements" }).expect(201);
      await as(u.n2.token).post(`/conversations/${channel.body.id}/messages`, { text: "Morning all" }).expect(201);
      await as(u.p.token).get(`/conversations/${channel.body.id}`).expect(404);

      const list = await as(u.n1.token).get("/conversations").expect(200);
      assert.deepEqual(list.body.data.map((c) => c.id), [channel.body.id, group.body.id, direct.body.id]);
      assert.equal(list.body.data[0].unreadCount, 1);
      await as(u.n1.token).post(`/conversations/${channel.body.id}/read`).expect(204);
      const read = await as(u.n1.token).get(`/conversations/${channel.body.id}`).expect(200);
      assert.equal(read.body.unreadCount, 0);
      const messages = await as(u.n1.token).get(`/conversations/${channel.body.id}/messages`).expect(200);
      assert.equal(messages.body.data[0].text, "Morning all");
      assert.equal(messages.body.data[0].senderRole, "nurse");

      await as(u.admin.token).patch(`/conversations/${channel.body.id}`, { status: "archived" }).expect(200);
      const archived = await as(u.n1.token).post(`/conversations/${channel.body.id}/messages`, { text: "Hello?" }).expect(409);
      assert.equal(archived.body.code, "invalid-state-transition");
      assert.ok(!(await as(u.n1.token).get("/conversations").expect(200)).body.data.some((c) => c.id === channel.body.id));
    });
  });

  describe("settings, preferences and alerts", () => {
    test("system settings: defaults, system-admin-only writes, deep merge", async () => {
      const defaults = await as(u.p.token).get("/system-settings").expect(200);
      assert.equal(defaults.body.appointments.defaultDurationMinutes, 30);
      assert.deepEqual(defaults.body.appointments.openingHours.days, [1, 2, 3, 4, 5]);
      await as(u.admin.token).patch("/system-settings", { organisationName: "Gauteng Health" }).expect(403);
      await as(u.sys.token).patch("/system-settings", { appointments: { openingHours: { start: "09:00", end: "08:00", days: [1] } } }).expect(400);
      const updated = await as(u.sys.token).patch("/system-settings", { organisationName: "Gauteng Health", appointments: { minLeadTimeMinutes: 30 } }).expect(200);
      assert.equal(updated.body.organisationName, "Gauteng Health");
      assert.equal(updated.body.appointments.minLeadTimeMinutes, 30);
      assert.equal(updated.body.appointments.bookingWindowDays, 90);
    });

    test("preferences: defaults and partial updates", async () => {
      const prefs = await as(u.n1.token).get("/me/preferences").expect(200);
      assert.deepEqual(prefs.body, { notifications: { inApp: true, email: false, sms: false }, language: "en", timeZone: "Africa/Johannesburg", updatedAt: null });
      const updated = await as(u.n1.token).patch("/me/preferences", { notifications: { sms: true }, language: "zu" }).expect(200);
      assert.deepEqual(updated.body.notifications, { inApp: true, email: false, sms: true });
      assert.equal(updated.body.language, "zu");
      await as(u.n1.token).patch("/me/preferences", { timeZone: "Mars/Olympus" }).expect(400);
      await as(u.n1.token).patch("/me/preferences", { theme: "dark" }).expect(400);
    });

    test("system alerts are scoped and resolvable", async () => {
      const alert = db.collection("systemAlerts").doc("a1");
      await alert.set({ title: "Disk", message: "Low", severity: "warning", status: "active", source: "system", facilityId: "f1", resource: null, resolvedAt: null, resolvedBy: null, ...audit("system") });
      await db.collection("systemAlerts").doc("a2").set({ title: "Other", message: "x", severity: "critical", status: "active", source: "system", facilityId: "f2", resource: null, resolvedAt: null, resolvedBy: null, ...audit("system") });
      await db.collection("systemAlerts").doc("a3").set({ title: "Wide", message: "All", severity: "info", status: "active", source: "system", facilityId: null, resource: null, resolvedAt: null, resolvedBy: null, ...audit("system") });
      // Facility admins see their facility's alerts plus system-wide ones (no PHI).
      const mine = await as(u.admin.token).get("/system-alerts?status=active").expect(200);
      assert.deepEqual(mine.body.data.map((a) => a.id).sort(), ["a1", "a3"]);
      const dashboard = await as(u.admin.token).get("/dashboard").expect(200);
      assert.equal(dashboard.body.counters.activeSystemAlerts, 2);
      assert.equal((await as(u.sys.token).get("/system-alerts?severity=critical").expect(200)).body.data.length, 1);
      await as(u.admin.token).patch("/system-alerts/a2", { status: "resolved" }).expect(404);
      const resolved = await as(u.admin.token).patch("/system-alerts/a1", { status: "resolved" }).expect(200);
      assert.equal(resolved.body.resolvedBy, u.admin.uid);
      await as(u.admin.token).patch("/system-alerts/a1", { status: "resolved" }).expect(409);
    });
  });

  describe("dashboards and reports", () => {
    test("nurse and patient dashboards", async () => {
      await db.collection("patients").doc(ids.w).update({ acuity: "critical" });
      const nurse = await as(u.n1.token).get("/dashboard").expect(200);
      assert.equal(nurse.body.role, "nurse");
      assert.equal(nurse.body.counters.patientsUnderCare, 1);
      assert.equal(nurse.body.counters.criticalPatients, 1);
      assert.ok(nurse.body.alerts.some((a) => a.type === "critical-patient" && a.patientName === "Sipho Dlamini"));
      const patient = await as(u.p.token).get("/dashboard").expect(200);
      assert.deepEqual(Object.keys(patient.body.counters).sort(), ["activePrescriptions", "unreadNotifications", "upcomingAppointments"]);
      assert.equal(patient.body.counters.activePrescriptions, 2);
    });

    test("reports: scoped, with small-cell suppression for admins", async () => {
      for (let i = 0; i < 5; i++) {
        const ref = db.collection("patients").doc(`bulk${i}`);
        await ref.set({
          userId: null, facilityId: "f1", status: "active", name: `Bulk ${i}`, nameLower: `bulk ${i}`, sex: "female", birthDate: "1950-01-01",
          allergies: [], noKnownAllergies: false, acuity: "stable", careTeam: [u.d1.uid], admission: null, admitted: false, latestVitals: null,
          chronicConditions: [{ name: "Type 2 diabetes", code: "E11.9" }], conditionCategories: ["E11"], ...audit("system"),
        });
      }
      const doctor = await as(u.d1.token).get("/reports/summary").expect(200);
      assert.deepEqual(doctor.body.scope, { type: "practitioner", id: u.d1.uid });
      assert.equal(doctor.body.patients.total, 8);
      assert.equal(doctor.body.patients.byAcuity.critical, 1);
      assert.deepEqual(doctor.body.patients.topConditions, [{ category: "E11", name: "Type 2 diabetes", count: 5 }]);
      assert.equal(doctor.body.patients.byAgeGroup["65+"], 5);
      assert.ok(doctor.body.prescriptions.topMedications.length >= 1);
      assert.equal(doctor.body.departments, null);

      const admin = await as(u.admin.token).get("/reports/summary").expect(200);
      assert.deepEqual(admin.body.scope, { type: "facility", id: "f1" });
      assert.equal(admin.body.patients.byAcuity.critical, null); // 1 is a small cell
      assert.equal(admin.body.patients.byAcuity.stable, 6); // bulk + the outpatient; Pat has no facility yet
      assert.equal(admin.body.patients.topConditions.length, 1);
      assert.ok(admin.body.prescriptions.topMedications.every((m) => m.count >= 5));
      const ward = admin.body.departments.find((d) => d.departmentId === "ward1");
      assert.equal(ward.admittedPatients, 1);
      assert.equal(ward.occupancyRate, 0.25);

      const nurse = await as(u.n1.token).get("/reports/summary").expect(200);
      assert.equal(nurse.body.prescriptions, null);
      await as(u.n1.token).get("/reports/summary?facilityId=f2").expect(403);
      await as(u.admin.token).get("/reports/summary?facilityId=f2").expect(403);
      await as(u.d1.token).get("/reports/summary?from=2020-01-01T00:00:00Z").expect(400);
    });
  });

  describe("discharge", () => {
    test("moves the admission to history", async () => {
      // An overdue patient task on the ward: on the nurse dashboard until the patient leaves the ward.
      const overdue = await as(u.d1.token)
        .post("/care-tasks", { patientId: ids.w, title: "HIV viral load follow-up", category: "other", dueAt: new Date(Date.now() + 3600e3).toISOString() })
        .expect(201);
      await db.collection("careTasks").doc(overdue.body.id).update({ dueAt: new Date(Date.now() - 3600e3) });
      const isAlert = (a) => a.type === "overdue-task" && a.message === "Overdue: HIV viral load follow-up";
      const before = await as(u.n1.token).get("/dashboard").expect(200);
      assert.ok(before.body.alerts.some(isAlert));

      const res = await as(u.d1.token).post(`/patients/${ids.w}/admission/discharge`, { dischargeNote: "Home" }).expect(200);
      assert.equal(res.body.admission, null);
      const history = await db.collection("patients").doc(ids.w).collection("admissions").get();
      assert.equal(history.size, 1);
      assert.equal(history.docs[0].get("dischargedBy"), u.d1.uid);
      await as(u.d1.token).post(`/patients/${ids.w}/admission/discharge`, {}).expect(409);
      assert.equal((await as(u.n1.token).get("/patients").expect(200)).body.data.length, 0); // no longer on the ward
      // The ward nurse loses the patient's tasks with the patient.
      await as(u.n1.token).get(`/care-tasks/${ids.task}`).expect(404);
      const tasks = await as(u.n1.token).get("/care-tasks?status=open,in-progress,completed").expect(200);
      assert.ok(!tasks.body.data.some((t) => t.patientId === ids.w));
      await as(u.d1.token).get(`/care-tasks/${ids.task}`).expect(200); // still on the care team
      const after = await as(u.n1.token).get("/dashboard").expect(200);
      assert.ok(!after.body.alerts.some(isAlert));
      assert.ok(!after.body.alerts.some((a) => a.patientId === ids.w));
      assert.equal(after.body.counters.tasksDueToday, before.body.counters.tasksDueToday - 1);

      // deceasedAt only goes with status deceased.
      await as(u.d1.token).patch(`/patients/${ids.w}`, { deceasedAt: "2026-01-01" }).expect(400);
      await as(u.d1.token).patch(`/patients/${ids.w}/admission`, { room: "5" }).expect(409);
      await as(u.d1.token).patch(`/patients/${ids.w}`, { status: "deceased" }).expect(400);
      await as(u.d1.token).patch(`/patients/${ids.w}`, { status: "deceased", deceasedAt: "2026-10-01" }).expect(200);
      // An explicit null cannot leave a deceased patient without a date.
      await as(u.d1.token).patch(`/patients/${ids.w}`, { deceasedAt: null }).expect(400);
      await as(u.d1.token).patch(`/patients/${ids.w}`, { status: "deceased", deceasedAt: null }).expect(400);
      const stored = (await db.collection("patients").doc(ids.w).get()).data();
      assert.equal(stored.status, "deceased");
      assert.ok(stored.deceasedAt);
      const revived = await as(u.d1.token).patch(`/patients/${ids.w}`, { status: "active" }).expect(200);
      assert.equal(revived.body.deceasedAt ?? null, null);
    });
  });

  describe("lists agree with the detail rules", () => {
    test("own prescriptions, records and administrations drop out with clinical access", async () => {
      const pid = (await as(u.admin.token).post("/patients", { name: "Secret Patient", sex: "female" }).expect(201)).body.id;
      await as(u.admin.token).post(`/patients/${pid}/care-team`, { userId: u.d1.uid }).expect(201);
      await as(u.d1.token).post(`/patients/${pid}/admission`, { departmentId: "ward1" }).expect(201);
      const rx = await as(u.d1.token)
        .post("/prescriptions", { patientId: pid, medication: "Tenofovir", dose: "300 mg", frequency: "as-needed", startDate: sastDay(-1) })
        .expect(201);
      const record = await as(u.d1.token)
        .post("/medical-records", { patientId: pid, category: "lab-result", title: "HIV result", findings: "B20", status: "preliminary" })
        .expect(201);
      await as(u.n1.token).post("/medication-administrations", { prescriptionId: rx.body.id, status: "completed" }).expect(201);

      const idsOf = (res) => res.body.data.map((d) => d.id);
      const mine = async () => ({
        rxs: idsOf(await as(u.d1.token).get("/prescriptions").expect(200)),
        records: idsOf(await as(u.d1.token).get("/medical-records").expect(200)),
      });
      const given = async () => (await as(u.n1.token).get("/medication-administrations?performerId=me").expect(200)).body.data;
      assert.ok((await mine()).rxs.includes(rx.body.id));
      assert.ok((await mine()).records.includes(record.body.id));
      assert.ok((await given()).some((a) => a.patientId === pid));

      // Removed from the care team (the ward rule is for nurses): the lists now agree with the 404 detail.
      await as(u.admin.token).delete(`/patients/${pid}/care-team/${u.d1.uid}`).expect(204);
      await as(u.d1.token).get(`/prescriptions/${rx.body.id}`).expect(404);
      await as(u.d1.token).get(`/medical-records/${record.body.id}`).expect(404);
      const after = await mine();
      assert.ok(!after.rxs.includes(rx.body.id));
      assert.ok(!after.records.includes(record.body.id));

      // The ward nurse keeps the administration until the patient leaves the ward.
      assert.ok((await given()).some((a) => a.patientId === pid));
      await as(u.admin.token).post(`/patients/${pid}/admission/discharge`, {}).expect(200);
      await as(u.n1.token).get(`/medication-administrations?patientId=${pid}`).expect(404);
      assert.ok(!(await given()).some((a) => a.patientId === pid));
    });
  });

  describe("filters", () => {
    test("unsupported appointment filter combinations are rejected", async () => {
      await as(u.admin.token).get(`/appointments?doctorId=${u.d1.uid}&departmentId=ward1`).expect(400);
      await as(u.n1.token).get("/appointments?doctorId=me").expect(400);
      const me = await as(u.p.token).post("/me", { birthDate: "04/05/1990" }).expect(400);
      assert.equal(me.body.errors[0].path, "birthDate");
    });
  });

  describe("staff who move facility", () => {
    test("old appointments, shifts and other departments' handovers stay out of scope", async () => {
      const now = Date.now();
      const iso = (ms) => new Date(ms).toISOString();
      u.d3 = await staffUser("d3@curecloud.test", "doctor", { name: "Doctor Three", facilityId: "f1" });
      u.admin2 = await staffUser("admin2@curecloud.test", "admin", { name: "Second Admin", facilityId: "f2" });

      // Rostered into Ward 1 without belonging to it: no Ward 1 handover note (§3.4).
      await as(u.admin.token).post("/shifts", { staffId: u.d3.uid, type: "day", start: iso(now - 3600e3), end: iso(now + 3600e3), departmentId: "ward1" }).expect(201);
      const current = await as(u.d3.token).get("/shifts/current").expect(200);
      assert.ok(current.body.shift);
      assert.equal(current.body.previousHandover, null);

      const appt = await as(u.p.token)
        .post("/appointments", { doctorId: u.d3.uid, start: weekdaySlot(4, "10:00"), type: "check-up", reason: "Check-up" })
        .expect(201);
      assert.equal(appt.body.facilityId, "f1");
      await db.collection("users").doc(u.d3.uid).update({ facilityId: "f2" });

      const appts = await as(u.admin2.token).get(`/appointments?doctorId=${u.d3.uid}`).expect(200);
      assert.equal(appts.body.data.length, 0);
      await as(u.admin2.token).get(`/appointments/${appt.body.id}`).expect(404);
      await as(u.admin.token).get(`/appointments?doctorId=${u.d3.uid}`).expect(403); // no longer in f1
      assert.equal((await as(u.sys.token).get(`/appointments?doctorId=${u.d3.uid}`).expect(200)).body.data.length, 1);

      const window = `from=${encodeURIComponent(iso(now - 86400e3))}&to=${encodeURIComponent(iso(now + 86400e3))}`;
      const shifts = await as(u.admin2.token).get(`/shifts?staffId=${u.d3.uid}&${window}`).expect(200);
      assert.equal(shifts.body.data.length, 0);
      assert.equal((await as(u.d3.token).get(`/shifts?staffId=me&${window}`).expect(200)).body.data.length, 1);
    });
  });
});
