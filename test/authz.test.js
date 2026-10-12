// The AuthZ matrix against the emulators (docs/domain-model.md §3, §8 "Tests"): each role allowed or
// denied per resource, relationship rules, field redaction, account-control invariants, actor
// filters, patient conversations and the write audit.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { as, db, googleUser, resetEmulators, seedDepartment, seedFacility, staffUser, weekdaySlot } from "./helpers.js";

describe("authorization", () => {
  const u = {};
  const ids = {};

  before(async () => {
    await resetEmulators();
    await seedFacility("f1");
    await seedFacility("f2", "Groote Schuur");
    await seedDepartment("ward1", "f1", "Ward 1");
    await seedDepartment("ward2", "f1", "Ward 2");
    await seedDepartment("wardX", "f2", "Ward X");
    u.sys = await staffUser("sys@curecloud.test", "admin", { name: "System Admin" });
    u.admin = await staffUser("admin.f1@curecloud.test", "admin", { name: "Facility Admin", facilityId: "f1" });
    u.admin2 = await staffUser("admin2.f1@curecloud.test", "admin", { name: "Second Admin", facilityId: "f1" });
    u.otherAdmin = await staffUser("admin.f2@curecloud.test", "admin", { name: "Other Admin", facilityId: "f2" });
    u.d1 = await staffUser("d1@curecloud.test", "doctor", { name: "Doctor One", facilityId: "f1", departmentId: "ward1" });
    u.d2 = await staffUser("d2@curecloud.test", "doctor", { name: "Doctor Two", facilityId: "f1", departmentId: "ward2" });
    u.n1 = await staffUser("n1@curecloud.test", "nurse", { name: "Nurse One", facilityId: "f1", departmentId: "ward1" });
    u.n2 = await staffUser("n2@curecloud.test", "nurse", { name: "Nurse Two", facilityId: "f1", departmentId: "ward2" });
    u.pending = await staffUser("pending@curecloud.test", "nurse", { name: "Pending Nurse", status: "pending" });
    u.p = await googleUser("p@gmail.test", "Patient Pat");
    u.q = await googleUser("q@gmail.test", "Patient Quinn");
    ids.p = (await as(u.p.token).post("/me", { sex: "female" }).expect(201)).body.patient.id;
    ids.q = (await as(u.q.token).post("/me", {}).expect(201)).body.patient.id;

    // Pat books Doctor One (joins the care team, gets facility f1). Quinn never books.
    const appt = await as(u.p.token).post("/appointments", { doctorId: u.d1.uid, start: weekdaySlot(3, "10:00"), reason: "Headaches" });
    assert.equal(appt.status, 201, JSON.stringify(appt.body));
    ids.appt = appt.body.id;

    // A walk-in registered by Doctor One and admitted to Ward 1 (Nurse One gets ward access).
    const walkIn = await as(u.d1.token)
      .post("/patients", {
        name: "Walk In",
        identifier: { type: "za-id", value: "9005045800083" },
        allergies: [{ substance: "Penicillin", severity: "severe" }],
        acuity: "high",
      })
      .expect(201);
    ids.w = walkIn.body.id;
    assert.equal(walkIn.body.birthDate, "1990-05-04"); // derived from the ID number
    assert.equal(walkIn.body.sex, "male");
    assert.equal(walkIn.body.identifier, undefined); // write-only for staff
    await as(u.d1.token).post(`/patients/${ids.w}/admission`, { departmentId: "ward1", room: "12", bed: "B" }).expect(201);
  });

  describe("role lacks the permission → 403 forbidden", () => {
    const cases = [
      ["p", "get", "/patients"],
      ["p", "post", "/prescriptions", { patientId: "x", medication: "A", dose: "1", frequency: "once-daily", startDate: "2026-01-01" }],
      ["p", "get", "/care-tasks"],
      ["p", "get", "/medication-schedule"],
      ["p", "get", "/reports/summary"],
      ["p", "get", "/departments"],
      ["n1", "post", "/prescriptions", { patientId: "x", medication: "A", dose: "1", frequency: "once-daily", startDate: "2026-01-01" }],
      ["n1", "get", "/users"],
      ["n1", "post", "/shifts", { staffId: "x", type: "day", start: "2030-01-01T08:00:00Z", end: "2030-01-01T16:00:00Z" }],
      ["d1", "patch", "/system-settings", { organisationName: "X" }],
      ["d1", "get", "/system-alerts"],
      ["d1", "post", "/departments", { name: "New", bedCapacity: 1 }],
      ["admin", "get", "/prescriptions"],
      ["admin", "get", "/medical-records"],
      ["admin", "get", "/care-tasks"],
      ["admin", "get", "/medication-schedule"],
      ["admin", "post", "/medical-records", { patientId: "x", category: "consultation", title: "T", findings: "F" }],
    ];
    for (const [who, method, path, body] of cases) {
      test(`${who} ${method.toUpperCase()} ${path}`, async () => {
        const res = await as(u[who].token)[method](path, body);
        assert.equal(res.status, 403, JSON.stringify(res.body));
        assert.equal(res.body.code, "forbidden");
      });
    }

    test("admins have no access to clinical child resources", async () => {
      for (const path of [`/patients/${ids.w}/vitals`, `/prescriptions?patientId=${ids.w}`, `/medical-records?patientId=${ids.w}`]) {
        const res = await as(u.admin.token).get(path);
        assert.equal(res.status, 403, path);
      }
    });

    test("inactive accounts are stopped before any permission check", async () => {
      const res = await as(u.pending.token).get("/practitioners").expect(403);
      assert.equal(res.body.code, "account-pending");
    });
  });

  describe("relationship rules → 404 when the resource is not visible", () => {
    test("patients", async () => {
      await as(u.d1.token).get(`/patients/${ids.w}`).expect(200); // care team
      await as(u.n1.token).get(`/patients/${ids.w}`).expect(200); // ward
      await as(u.d2.token).get(`/patients/${ids.w}`).expect(404);
      await as(u.n2.token).get(`/patients/${ids.w}`).expect(404);
      await as(u.admin.token).get(`/patients/${ids.w}`).expect(200); // facility
      await as(u.otherAdmin.token).get(`/patients/${ids.w}`).expect(404);
      await as(u.q.token).get(`/patients/${ids.p}`).expect(404);
      // A self-registered patient who never booked is invisible to facility admins.
      await as(u.admin.token).get(`/patients/${ids.q}`).expect(404);
      await as(u.sys.token).get(`/patients/${ids.q}`).expect(200);
    });

    test("child resources inherit clinical access from the patient", async () => {
      await as(u.n1.token).post(`/patients/${ids.w}/vitals`, { heartRate: 80 }).expect(201);
      await as(u.n2.token).post(`/patients/${ids.w}/vitals`, { heartRate: 80 }).expect(404);
      await as(u.d2.token).get(`/prescriptions?patientId=${ids.w}`).expect(404);
      await as(u.q.token).get(`/prescriptions?patientId=${ids.p}`).expect(404);
      await as(u.q.token).get(`/appointments/${ids.appt}`).expect(404);
      await as(u.p.token).get(`/appointments/${ids.appt}`).expect(200);
      await as(u.otherAdmin.token).get(`/appointments/${ids.appt}`).expect(404);
    });

    test("lists are scoped", async () => {
      const d1 = await as(u.d1.token).get("/patients").expect(200);
      assert.deepEqual(d1.body.data.map((p) => p.name).sort(), ["Patient Pat", "Walk In"]);
      const n1 = await as(u.n1.token).get("/patients").expect(200);
      assert.deepEqual(n1.body.data.map((p) => p.name), ["Walk In"]);
      assert.equal((await as(u.n2.token).get("/patients").expect(200)).body.data.length, 0);
      const admin = await as(u.admin.token).get("/patients").expect(200);
      assert.deepEqual(admin.body.data.map((p) => p.name).sort(), ["Patient Pat", "Walk In"]);
      const sys = await as(u.sys.token).get("/patients").expect(200);
      assert.equal(sys.body.data.length, 3);
      assert.equal((await as(u.otherAdmin.token).get("/patients").expect(200)).body.data.length, 0);
      const search = await as(u.d1.token).get("/patients?q=WALK").expect(200);
      assert.deepEqual(search.body.data.map((p) => p.name), ["Walk In"]);
      const admitted = await as(u.admin.token).get("/patients?admitted=true").expect(200);
      assert.deepEqual(admitted.body.data.map((p) => p.name), ["Walk In"]);
      await as(u.admin.token).get("/patients?q=w&admitted=true").expect(400);
    });
  });

  describe("visible, but the action or field is not allowed → 403", () => {
    test("patient field sets", async () => {
      const acuity = await as(u.p.token).patch(`/patients/${ids.p}`, { acuity: "critical" }).expect(403);
      assert.match(acuity.body.detail, /acuity/);
      await as(u.p.token).patch(`/patients/${ids.p}`, { phone: "0831234567", address: { line1: "1 Main Rd", city: "Soweto", province: "gauteng", postalCode: "1818" } }).expect(200);
      await as(u.p.token).patch(`/patients/${ids.p}`, { identifier: { type: "passport", value: "A1234567", country: "ZW" } }).expect(200);
      // identifier is writable for self only while it is unset
      await as(u.p.token).patch(`/patients/${ids.p}`, { identifier: { type: "passport", value: "B1234567", country: "ZW" } }).expect(403);
      const allergies = await as(u.admin.token).patch(`/patients/${ids.w}`, { allergies: [] }).expect(403);
      assert.match(allergies.body.detail, /allergies/);
      await as(u.admin.token).patch(`/patients/${ids.w}`, { status: "deceased", deceasedAt: "2026-10-01" }).expect(403);
      await as(u.n1.token).patch(`/patients/${ids.w}`, { status: "inactive" }).expect(403);
      await as(u.n1.token).patch(`/patients/${ids.w}`, { careTeam: [] }).expect(400); // no longer accepted at all
      const created = await as(u.admin.token).post("/patients", { name: "Clinical Admin", acuity: "high" }).expect(403);
      assert.match(created.body.detail, /acuity/);
    });

    test("admission, care team and records", async () => {
      await as(u.n1.token).post(`/patients/${ids.w}/admission/discharge`, {}).expect(403);
      await as(u.n1.token).patch(`/patients/${ids.w}/admission`, { departmentId: "ward2" }).expect(403);
      await as(u.n1.token).patch(`/patients/${ids.w}/admission`, { bed: "C" }).expect(200);
      await as(u.d1.token).delete(`/patients/${ids.w}/care-team/${u.d1.uid}`).expect(403);

      const draft = await as(u.d1.token)
        .post("/medical-records", { patientId: ids.w, category: "progress-note", title: "Ward round", findings: "Stable", status: "preliminary" })
        .expect(201);
      const finalise = await as(u.n1.token).patch(`/medical-records/${draft.body.id}`, { status: "final" }).expect(403);
      assert.equal(finalise.body.code, "forbidden");
      await as(u.n1.token).post("/medical-records", { patientId: ids.w, category: "consultation", title: "X", findings: "Y" }).expect(403);
      await as(u.n1.token).post("/medical-records", { patientId: ids.w, category: "nursing-note", title: "Obs", findings: "Comfortable" }).expect(201);

      const vitals = await as(u.n1.token).get(`/patients/${ids.w}/vitals`).expect(200);
      const retract = await as(u.d1.token).patch(`/patients/${ids.w}/vitals/${vitals.body.data[0].id}`, { status: "entered-in-error", statusReason: "x" }).expect(403);
      assert.equal(retract.body.code, "forbidden");
    });

    test("PATCH /me rejects contact fields for patients", async () => {
      const res = await as(u.p.token).patch("/me", { phone: "0821112222" }).expect(403);
      assert.match(res.body.detail, /phone/);
      await as(u.p.token).patch("/me", { emergencyContact: { name: "Mom", relationship: "mother", phone: "0821112222" } }).expect(403);
      const renamed = await as(u.p.token).patch("/me", { name: "Patricia Pat" }).expect(200);
      assert.equal(renamed.body.patient.name, "Patricia Pat"); // mirrored to the linked patient
      const staff = await as(u.d1.token).patch("/me", { phone: "082 333 4444", practitioner: { bio: "GP" } }).expect(200);
      assert.equal(staff.body.user.phone, "+27823334444");
      assert.equal(staff.body.user.practitioner.bio, "GP");
      await as(u.d1.token).patch("/me", { practitioner: { licenceNumber: "X1234" } }).expect(400); // admin-only field
      await as(u.d1.token).patch("/me", { role: "admin" }).expect(400);
    });
  });

  describe("field redaction", () => {
    test("patients per access level", async () => {
      const clinical = await as(u.n1.token).get(`/patients/${ids.w}`).expect(200);
      assert.equal(clinical.body.identifier, undefined);
      assert.equal(clinical.body.acuity, "high");
      assert.equal(clinical.body.allergies[0].substance, "Penicillin");
      const admin = await as(u.admin.token).get(`/patients/${ids.w}`).expect(200);
      assert.equal(admin.body.identifier.value, "9005045800083");
      assert.equal(admin.body.admission.room, "12");
      for (const f of ["acuity", "allergies", "chronicConditions", "bloodType", "latestVitals", "noKnownAllergies"]) {
        assert.equal(admin.body[f], undefined, f);
      }
      const self = await as(u.p.token).get(`/patients/${ids.p}`).expect(200);
      assert.equal(self.body.identifier.type, "passport");
      assert.equal(self.body.acuity, "stable");
    });

    test("appointment reasons are hidden from admins and department-only nurses", async () => {
      assert.equal((await as(u.d1.token).get(`/appointments/${ids.appt}`).expect(200)).body.reason, "Headaches");
      assert.equal((await as(u.p.token).get(`/appointments/${ids.appt}`).expect(200)).body.reason, "Headaches");
      const admin = await as(u.admin.token).get(`/appointments/${ids.appt}`).expect(200);
      assert.equal(admin.body.reason, undefined);
      const nurse = await as(u.n1.token).get(`/appointments?departmentId=ward1`).expect(200);
      assert.equal(nurse.body.data.length, 1);
      assert.equal(nurse.body.data[0].reason, undefined);
    });

    test("users: lastSignInAt for admins; PII only for self and admins in scope", async () => {
      const list = await as(u.admin.token).get("/users?role=doctor").expect(200);
      assert.deepEqual(list.body.data.map((x) => x.name), ["Doctor One", "Doctor Two"]);
      assert.ok(list.body.data.every((x) => "lastSignInAt" in x));
      const me = await as(u.d1.token).get("/me").expect(200);
      assert.equal(me.body.user.lastSignInAt, undefined);
    });
  });

  describe("account control (PATCH /users/{id})", () => {
    test("nobody changes their own role, status, facility or department", async () => {
      for (const body of [{ facilityId: null }, { facilityId: "f2" }, { role: "doctor", practitioner: { licenceNumber: "MP1234" } }, { status: "disabled" }, { departmentId: "ward1" }]) {
        const res = await as(u.admin.token).patch(`/users/${u.admin.uid}`, body);
        assert.equal(res.status, 403, JSON.stringify(body));
      }
    });

    test("facility admins cannot touch system admins, admin roles or other admins", async () => {
      await as(u.admin.token).patch(`/users/${u.sys.uid}`, { status: "disabled" }).expect(404); // outside userScope
      await as(u.admin.token).patch(`/users/${u.d1.uid}`, { role: "admin" }).expect(403);
      await as(u.admin.token).patch(`/users/${u.admin2.uid}`, { facilityId: null }).expect(403);
      await as(u.admin.token).patch(`/users/${u.admin2.uid}`, { status: "disabled" }).expect(403);
      await as(u.otherAdmin.token).patch(`/users/${u.d1.uid}`, { status: "disabled" }).expect(404);
      await as(u.admin.token).patch(`/users/${u.p.uid}`, { status: "disabled" }).expect(404); // patient accounts
      await as(u.admin.token).get(`/users?role=patient`).expect(403);
    });

    test("facility admins approve pending unassigned staff into their own facility only", async () => {
      const pending = await as(u.admin.token).get("/users?status=pending").expect(200);
      assert.deepEqual(pending.body.data.map((x) => x.id), [u.pending.uid]);
      await as(u.admin.token).patch(`/users/${u.pending.uid}`, { status: "active", facilityId: "f2", departmentId: "wardX" }).expect(403);
      const noDept = await as(u.admin.token).patch(`/users/${u.pending.uid}`, { status: "active", facilityId: "f1" }).expect(400);
      assert.match(noDept.body.detail, /departmentId/);
      await as(u.admin.token).patch(`/users/${u.pending.uid}`, { status: "active", facilityId: "f1", departmentId: "wardX" }).expect(400);
      const ok = await as(u.admin.token).patch(`/users/${u.pending.uid}`, { status: "active", facilityId: "f1", departmentId: "ward2" }).expect(200);
      assert.equal(ok.body.facilityId, "f1");
      // Once in the facility, a facility admin cannot move them out.
      await as(u.admin.token).patch(`/users/${u.pending.uid}`, { facilityId: null }).expect(403);
      const back = await as(u.admin.token).patch(`/users/${u.pending.uid}`, { status: "pending" }).expect(409);
      assert.equal(back.body.code, "invalid-state-transition");
    });

    test("doctor ↔ nurse changes need a new licence number", async () => {
      await as(u.admin.token).patch(`/users/${u.pending.uid}`, { role: "doctor" }).expect(400);
      const changed = await as(u.admin.token).patch(`/users/${u.pending.uid}`, { role: "doctor", practitioner: { licenceNumber: "MP9999" } }).expect(200);
      assert.equal(changed.body.practitioner.licenceBody, "hpcsa");
      const events = await db.collection("auditEvents").where("resource.id", "==", u.pending.uid).get();
      assert.ok(events.docs.some((d) => d.get("changedFields").includes("role")));
    });

    test("the last active system admin is protected", async () => {
      for (const body of [{ facilityId: "f1" }, { role: "doctor", practitioner: { licenceNumber: "MP1111" } }, { status: "disabled" }]) {
        const res = await as(u.sys.token).patch(`/users/${u.sys.uid}`, body);
        assert.equal(res.status, 409, JSON.stringify(res.body));
        assert.equal(res.body.code, "conflict");
      }
      // System admins may manage patient accounts, but patients never become staff.
      await as(u.sys.token).patch(`/users/${u.p.uid}`, { role: "doctor", practitioner: { licenceNumber: "MP1111" } }).expect(400);
    });

    test("system admins can promote and demote admins", async () => {
      const promoted = await as(u.sys.token).patch(`/users/${u.d2.uid}`, { role: "admin" }).expect(200);
      assert.equal(promoted.body.practitioner, null);
      const legacy = (await db.collection("users").doc(u.d2.uid).get()).get("legacy.practitioner");
      assert.equal(legacy.licenceBody, "hpcsa");
      await as(u.sys.token).patch(`/users/${u.d2.uid}`, { role: "doctor" }).expect(400);
      await as(u.sys.token).patch(`/users/${u.d2.uid}`, { role: "doctor", practitioner: { licenceNumber: "MP2222" } }).expect(200);
    });
  });

  describe("actor filters", () => {
    test("doctors and nurses only filter by their own ID without a clinical patientId", async () => {
      await as(u.d1.token).get(`/prescriptions?prescriberId=${u.d2.uid}`).expect(403);
      await as(u.d1.token).get(`/prescriptions?prescriberId=me`).expect(200);
      await as(u.d1.token).get(`/prescriptions?patientId=${ids.w}&prescriberId=${u.d2.uid}`).expect(200);
      await as(u.n1.token).get(`/medication-administrations?performerId=${u.n2.uid}`).expect(403);
      await as(u.n1.token).get(`/medication-administrations?performerId=${u.n2.uid}&patientId=${ids.w}`).expect(200);
      await as(u.n1.token).get(`/medical-records?authorId=${u.d1.uid}`).expect(403);
      await as(u.d1.token).get(`/appointments?doctorId=${u.d2.uid}`).expect(403);
      await as(u.n1.token).get(`/care-tasks?departmentId=ward2`).expect(403);
      await as(u.d1.token).get(`/care-tasks?assigneeId=${u.n1.uid}`).expect(403);
      // Admins may filter appointments by doctors of their own facility.
      await as(u.admin.token).get(`/appointments?doctorId=${u.d1.uid}`).expect(200);
      await as(u.otherAdmin.token).get(`/appointments?doctorId=${u.d1.uid}`).expect(403);
    });
  });

  describe("patient conversations", () => {
    test("exactly the patient's account plus active care team staff", async () => {
      const withOtherPatient = await as(u.p.token)
        .post("/conversations", { type: "patient", patientId: ids.p, participantIds: [u.d1.uid, u.q.uid] })
        .expect(403);
      assert.equal(withOtherPatient.body.code, "forbidden");
      await as(u.p.token).post("/conversations", { type: "patient", patientId: ids.p, participantIds: [u.d2.uid] }).expect(403);
      await as(u.p.token).post("/conversations", { type: "patient", patientId: ids.q, participantIds: [u.d1.uid] }).expect(404);
      await as(u.p.token).post("/conversations", { type: "direct", participantIds: [u.d1.uid] }).expect(403);
      const ok = await as(u.p.token).post("/conversations", { type: "patient", patientId: ids.p, participantIds: [u.d1.uid] }).expect(201);
      assert.equal(ok.body.type, "patient");
      ids.conversation = ok.body.id;
      // Staff outside the conversation cannot read it.
      await as(u.d2.token).get(`/conversations/${ids.conversation}`).expect(404);
      await as(u.d1.token).post(`/conversations/${ids.conversation}/messages`, { text: "How are the headaches?" }).expect(201);
      const unread = await as(u.p.token).get("/conversations").expect(200);
      assert.equal(unread.body.data[0].unreadCount, 1);
      assert.equal(unread.body.data[0].lastReadAt, undefined);
    });
  });

  describe("booking rules and the write audit", () => {
    test("booking outside opening hours or during leave returns 409 slot-unavailable", async () => {
      const day = weekdaySlot(5, "08:00").slice(0, 10);
      await as(u.admin.token)
        .post("/shifts", { staffId: u.d1.uid, type: "leave", start: `${day}T08:00:00+02:00`, end: `${day}T16:30:00+02:00` })
        .expect(201);
      const leave = await as(u.p.token).post("/appointments", { doctorId: u.d1.uid, start: `${day}T11:00:00+02:00` }).expect(409);
      assert.equal(leave.body.code, "slot-unavailable");
      const early = await as(u.p.token).post("/appointments", { doctorId: u.d1.uid, start: weekdaySlot(6, "07:45") }).expect(409);
      assert.equal(early.body.code, "slot-unavailable");
      const late = await as(u.p.token).post("/appointments", { doctorId: u.d1.uid, start: weekdaySlot(6, "16:15"), durationMinutes: 30 }).expect(409);
      assert.equal(late.body.code, "slot-unavailable");
      const busy = await as(u.p.token).get(`/practitioners/${u.d1.uid}/busy?from=${encodeURIComponent(`${day}T00:00:00+02:00`)}&to=${encodeURIComponent(`${day}T23:59:00+02:00`)}`).expect(200);
      assert.deepEqual(busy.body.data, [{ start: new Date(`${day}T08:00:00+02:00`).toISOString(), end: new Date(`${day}T16:30:00+02:00`).toISOString() }]);
    });

    test("a clinical PATCH of allergies writes exactly one audit event, without values", async () => {
      const before = await db.collection("auditEvents").where("patientId", "==", ids.w).get();
      await as(u.d1.token).patch(`/patients/${ids.w}`, { allergies: [{ substance: "Sulfa", severity: "moderate" }] }).expect(200);
      const after = await db.collection("auditEvents").where("patientId", "==", ids.w).get();
      const added = after.docs.filter((d) => !before.docs.some((b) => b.id === d.id));
      assert.equal(added.length, 1);
      const event = added[0].data();
      assert.deepEqual(event.changedFields, ["allergies"]);
      assert.equal(event.actorId, u.d1.uid);
      assert.equal(event.action, "update");
      assert.doesNotMatch(JSON.stringify(event), /Sulfa/);
    });

    test("duplicate identity numbers are rejected without revealing the patient", async () => {
      const dup = await as(u.admin.token).post("/patients", { name: "Same Person", identifier: { type: "za-id", value: "9005045800083" } }).expect(409);
      assert.equal(dup.body.code, "duplicate-identifier");
      assert.doesNotMatch(JSON.stringify(dup.body), new RegExp(ids.w));
      const locks = await db.collection("patientIdentifiers").get();
      assert.ok(locks.docs.every((d) => /^[0-9a-f]{64}$/.test(d.id)));
      assert.ok(!locks.docs.some((d) => d.id.includes("9005045800083")));
    });
  });
});
