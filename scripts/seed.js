// Seeds v2-shaped demo data (docs/domain-model.md §2) into the LOCAL emulators for an account you've
// already signed into. Re-running overwrites the same demo documents.
//   1. npm run serve   2. sign in with Google in the CureCloud client (`npm run dev:emulator`)
//   3. npm run seed -- you@example.com doctor      (role: doctor | nurse | admin | patient)
// "admin" seeds a facility admin of the demo hospital; the bootstrap admin (POST /me) is a system admin.
import { FieldValue, Timestamp } from "firebase-admin/firestore";

// Always the emulators: the seed never touches a live project.
if (!process.env.FIRESTORE_EMULATOR_HOST) process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ??= "curecloud1"; // the project ID `npm run serve` emulates

const { auth, db } = await import("../src/firebase.js");
const { createdFields, nameLower } = await import("../src/lib/write.js");
const { sastInstant, sastDate } = await import("../src/lib/dates.js");
const { newPatientDoc } = await import("../src/routes/v1/patients.js");
const { FREQUENCY_TIMES, LICENCE_BODIES } = await import("../src/models/index.js");

const [email, role = "doctor"] = process.argv.slice(2);
if (!email || !["doctor", "nurse", "admin", "patient"].includes(role)) {
  console.error("Usage: npm run seed -- <email> <doctor|nurse|admin|patient>");
  process.exit(1);
}

const me = await auth.getUserByEmail(email).catch(() => null);
if (!me) {
  console.error(`No emulator account for ${email}. Sign in through the app first.`);
  process.exit(1);
}

const FACILITY = "default";
const WARD = "dept-medicine";
const DAY = 86400e3;
const ts = (date) => Timestamp.fromDate(date);
const day = (n) => sastDate(new Date(Date.now() + n * DAY));
// The next weekday at least `n` days ahead, at a SAST wall-clock time inside the default opening hours.
const weekday = (n, time) => {
  for (let d = n; ; d++) {
    const date = day(d);
    const weekdayNo = new Date(`${date}T12:00:00+02:00`).getUTCDay();
    if (weekdayNo >= 1 && weekdayNo <= 5) return sastInstant(date, time);
  }
};

const system = { id: "system", role: "system" };
const batch = db.batch();
const put = (path, data) => batch.set(db.doc(path), data);

// --- Organisation -----------------------------------------------------------------------------
put(`facilities/${FACILITY}`, {
  name: "CureCloud Demo Hospital",
  type: "hospital",
  address: { line1: "26 Chris Hani Rd", line2: null, suburb: "Diepkloof", city: "Soweto", province: "gauteng", postalCode: "1864", country: "ZA" },
  phone: "+27119338000",
  email: null,
  status: "active",
  ...createdFields(system),
});
for (const [id, name, bedCapacity] of [
  [WARD, "General Medicine", 24],
  ["dept-paeds", "Paediatrics", 16],
  ["dept-outpatients", "Outpatients", 0],
]) {
  put(`departments/${id}`, {
    facilityId: FACILITY,
    name,
    nameLower: nameLower(name),
    headId: null,
    headName: null,
    location: null,
    phone: null,
    bedCapacity,
    status: "active",
    ...createdFields(system),
  });
}

// --- Accounts ---------------------------------------------------------------------------------
const staffDoc = (id, name, staffRole, extra = {}) => ({
  email: extra.email ?? `${id}@curecloud.test`,
  name,
  nameLower: nameLower(name),
  phone: null,
  photoUrl: null,
  role: staffRole,
  status: "active",
  statusReason: null,
  facilityId: FACILITY,
  departmentId: WARD,
  identifier: null,
  emergencyContact: null,
  practitioner: LICENCE_BODIES[staffRole]
    ? { licenceBody: LICENCE_BODIES[staffRole], licenceNumber: "MP0123456", specialization: extra.specialization ?? null, qualifications: [] }
    : null,
  ...createdFields(system),
});

const myName = me.displayName ?? email.split("@")[0];
const doctor = role === "doctor" ? { id: me.uid, name: myName } : { id: "demo-doctor", name: "Dr. James Wilson" };
const nurse = role === "nurse" ? { id: me.uid, name: myName } : { id: "demo-nurse", name: "Sister Nomsa Khumalo" };
if (role === "patient") {
  put(`users/${me.uid}`, {
    ...staffDoc(me.uid, myName, "patient", { email }),
    facilityId: null,
    departmentId: null,
    photoUrl: me.photoURL ?? null,
  });
} else {
  put(`users/${me.uid}`, {
    ...staffDoc(me.uid, myName, role, { email, specialization: role === "doctor" ? "General Practice" : null }),
    photoUrl: me.photoURL ?? null,
    ...(role === "admin" && { departmentId: null }),
  });
}
if (doctor.id !== me.uid) put(`users/${doctor.id}`, staffDoc(doctor.id, doctor.name, "doctor", { specialization: "Endocrinology" }));
if (nurse.id !== me.uid) put(`users/${nurse.id}`, staffDoc(nurse.id, nurse.name, "nurse"));

// --- Patients ---------------------------------------------------------------------------------
const careTeam = [doctor.id, nurse.id];
const now = new Date();
const admission = (room, bed) => ({
  departmentId: WARD,
  departmentName: "General Medicine",
  ward: "Ward 4",
  room,
  bed,
  admittedAt: ts(new Date(Date.now() - 2 * DAY)),
  admittedBy: doctor.id,
  attendingDoctorId: doctor.id,
});
const vitals = (bp, heartRate, extra = {}) => ({ bloodPressure: bp, heartRate, ...extra, recordedAt: ts(now) });
const demoPatients = [
  {
    id: "demo-patient-1", name: "John Doe", sex: "male", birthDate: "1958-03-14", folderNumber: "BH-1001", acuity: "stable",
    chronicConditions: [{ name: "Type 2 diabetes", code: "E11.9", since: "2015-01-01", notes: null }],
    allergies: [{ substance: "Penicillin", reaction: "Rash", severity: "moderate", notedOn: null }],
    latestVitals: vitals({ systolic: 128, diastolic: 82 }, 76, { bloodGlucose: 8.4, temperature: 36.8 }),
    admission: admission("101", "A"),
  },
  {
    id: "demo-patient-2", name: "Jane Smith", sex: "female", birthDate: "1979-11-02", folderNumber: "BH-1002", acuity: "critical",
    chronicConditions: [{ name: "Essential hypertension", code: "I10", since: null, notes: null }],
    allergies: [],
    noKnownAllergies: true,
    latestVitals: vitals({ systolic: 168, diastolic: 104 }, 112, { oxygenSaturation: 91 }),
    admission: admission("102", "B"),
  },
  { id: "demo-patient-3", name: "Alice Johnson", sex: "female", birthDate: "1992-06-21", folderNumber: "BH-1003", acuity: "stable", latestVitals: vitals({ systolic: 118, diastolic: 76 }, 70) },
  { id: "demo-patient-4", name: "Michael Brown", sex: "male", birthDate: "1965-09-30", folderNumber: "BH-1004", acuity: "high", admission: admission("104", "A") },
  { id: "demo-patient-5", name: "Emily Davis", sex: "female", birthDate: "2015-04-11", folderNumber: "BH-1005", acuity: "moderate" },
];
if (role === "patient") {
  demoPatients.unshift({
    id: me.uid, userId: me.uid, name: myName, email, sex: "unknown", acuity: "stable",
    latestVitals: vitals({ systolic: 120, diastolic: 80 }, 72, { weight: 68, bloodGlucose: 5.3 }),
  });
}
for (const { id, admission: adm, latestVitals, ...fields } of demoPatients) {
  put(`patients/${id}`, {
    ...newPatientDoc(doctor, { ...fields, facilityId: FACILITY, careTeam }),
    latestVitals: latestVitals ?? null,
    admission: adm ?? null,
    admitted: Boolean(adm),
  });
}
const [first, second] = demoPatients;
put(`patients/${first.id}/vitals/demo-vitals-1`, {
  patientId: first.id,
  recordedAt: ts(now),
  status: "final",
  statusReason: null,
  ...first.latestVitals,
  notes: null,
  createdByName: nurse.name,
  ...createdFields(nurse),
});

// --- Appointments with their 15-minute slot locks -------------------------------------------
const appointments = [
  ["demo-appt-1", first, weekday(1, "09:00"), "follow-up", "confirmed", "Diabetes review"],
  ["demo-appt-2", second, weekday(2, "14:30"), "consultation", "pending", "Blood pressure follow-up"],
  ["demo-appt-3", first, weekday(7, "10:00"), "check-up", "pending", null],
];
for (const [id, patient, start, type, status, reason] of appointments) {
  const end = new Date(start.getTime() + 30 * 60e3);
  for (const unit of [start, new Date(start.getTime() + 15 * 60e3)]) {
    put(`appointmentSlots/${doctor.id}_${unit.getTime()}`, { doctorId: doctor.id, start: ts(unit), appointmentId: id });
  }
  put(`appointments/${id}`, {
    patientId: patient.id,
    patientName: patient.name,
    patientUserId: patient.userId ?? null,
    doctorId: doctor.id,
    doctorName: doctor.name,
    facilityId: FACILITY,
    departmentId: WARD,
    start: ts(start),
    end: ts(end),
    durationMinutes: 30,
    type,
    reason,
    status,
    cancellationReason: null,
    cancelledBy: null,
    checkedInAt: null,
    ...createdFields(doctor),
  });
}

// --- Prescriptions (inpatient doses feed the nurse medication schedule) ----------------------
for (const [id, medication, dose, frequency, category] of [
  ["demo-rx-1", "Metformin", "500 mg", "twice-daily", "inpatient"],
  ["demo-rx-2", "Enalapril", "10 mg", "once-daily", "inpatient"],
  ["demo-rx-3", "Paracetamol", "1 g", "as-needed", "inpatient"],
]) {
  put(`prescriptions/${id}`, {
    patientId: first.id,
    patientName: first.name,
    facilityId: FACILITY,
    prescriberId: doctor.id,
    prescriberName: doctor.name,
    category,
    medication,
    dose,
    route: "oral",
    frequency,
    frequencyText: null,
    administrationTimes: FREQUENCY_TIMES[frequency],
    instructions: frequency === "as-needed" ? "For pain or fever, at most 4 g a day" : null,
    refills: 2,
    startDate: day(-7),
    endDate: day(30),
    status: "active",
    statusReason: null,
    appointmentId: null,
    ...createdFields(doctor),
  });
}

put("medicalRecords/demo-record-1", {
  patientId: first.id,
  patientName: first.name,
  authorId: doctor.id,
  authorName: doctor.name,
  authorRole: "doctor",
  category: "lab-result",
  title: "HbA1c and renal function",
  effectiveAt: ts(new Date(Date.now() - 14 * DAY)),
  status: "final",
  statusReason: null,
  diagnosis: "Type 2 diabetes, suboptimal control",
  diagnosisCode: "E11.9",
  findings: "HbA1c above target; renal function normal.",
  treatment: null,
  recommendations: "Continue metformin, repeat HbA1c in 3 months.",
  labResults: [
    { name: "HbA1c", code: "4548-4", value: "8.1", unit: "%", referenceRange: "< 7.0", flag: "high" },
    { name: "Creatinine", code: null, value: "84", unit: "µmol/L", referenceRange: "64–104", flag: "normal" },
  ],
  appointmentId: null,
  addenda: [],
  ...createdFields(doctor),
});

// --- Nursing work and the roster --------------------------------------------------------------
for (const [id, patient, title, category, priority, hours, assignee] of [
  ["demo-task-1", first, "4-hourly observations", "vitals", "high", 1, nurse],
  ["demo-task-2", second, "Blood pressure check", "vitals", "urgent", 0.5, null],
  ["demo-task-3", null, "Restock the crash trolley", "admin", "normal", 6, null],
]) {
  put(`careTasks/${id}`, {
    patientId: patient?.id ?? null,
    patientName: patient?.name ?? null,
    facilityId: FACILITY,
    departmentId: WARD,
    title,
    description: null,
    category,
    priority,
    dueAt: ts(new Date(Date.now() + hours * 3600e3)),
    status: "open",
    assigneeId: assignee?.id ?? null,
    assigneeName: assignee?.name ?? null,
    startedAt: null,
    completedAt: null,
    completedBy: null,
    completionNote: null,
    ...createdFields(doctor),
  });
}
const today = sastDate();
for (const [id, staff, staffRole, type, start, end] of [
  ["demo-shift-1", nurse, "nurse", "day", sastInstant(today, "07:00"), sastInstant(today, "19:00")],
  ["demo-shift-2", doctor, "doctor", "day", sastInstant(today, "08:00"), sastInstant(today, "16:30")],
  ["demo-shift-3", doctor, "doctor", "leave", sastInstant(day(14), "08:00"), sastInstant(day(14), "16:30")],
]) {
  put(`shifts/${id}`, {
    staffId: staff.id,
    staffName: staff.name,
    staffRole,
    facilityId: FACILITY,
    departmentId: WARD,
    type,
    start: ts(start),
    end: ts(end),
    status: "scheduled",
    handoverNote: null,
    handoverAt: null,
    ...createdFields(system),
  });
}

// --- Messaging and the inbox ------------------------------------------------------------------
put("conversations/demo-channel-1", {
  type: "channel",
  title: "General Medicine",
  facilityId: FACILITY,
  departmentId: WARD,
  patientId: null,
  participantIds: [],
  participants: {},
  lastMessage: null,
  lastMessageAt: FieldValue.serverTimestamp(),
  lastReadAt: {},
  status: "active",
  ...createdFields(system),
});
for (const [id, title, description, type, priority, resource] of [
  ["demo-note-1", "Welcome to CureCloud", "Your demo data is ready.", "system", "normal", null],
  ["demo-note-2", "Upcoming appointment", `Follow-up on ${sastDate(appointments[0][2])}`, "appointment", "important", { type: "appointment", id: "demo-appt-1" }],
]) {
  put(`notifications/${id}`, {
    userId: me.uid,
    title,
    description,
    type,
    priority,
    resource,
    read: false,
    readAt: null,
    expiresAt: ts(new Date(Date.now() + 90 * DAY)),
    ...createdFields(system),
  });
}

await batch.commit();
console.log(`Seeded emulator data for ${email} as ${role}.`);
process.exit(0);
