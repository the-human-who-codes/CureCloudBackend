// Seeds demo data into the LOCAL emulators for an account you've already signed into.
//   1. npm run serve   2. sign in with Google in the CureCloud client (`npm run dev:emulator`)
//   3. npm run seed -- you@example.com doctor      (role: doctor | nurse | admin | patient)
import { FieldValue, Timestamp } from "firebase-admin/firestore";

if (!process.env.FIRESTORE_EMULATOR_HOST) process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.GCLOUD_PROJECT ??= "curecloud1";

const { auth, db } = await import("../src/firebase.js");
const { toScheduledAt } = await import("../src/lib/dates.js");

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

const now = FieldValue.serverTimestamp();
const day = (n) => new Date(Date.now() + 2 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const batch = db.batch();

// A demo doctor is needed so patients have someone to book with.
const doctorId = role === "doctor" ? me.uid : "demo-doctor";
batch.set(db.collection("users").doc(me.uid), {
  name: me.displayName ?? email.split("@")[0],
  email,
  role,
  status: "active",
  phoneNumber: null,
  facilityId: null,
  specialization: role === "doctor" ? "General Practice" : null,
  createdAt: now,
});
if (role !== "doctor") {
  batch.set(db.collection("users").doc(doctorId), {
    name: "Dr. James Wilson",
    email: "j.wilson@curecloud.test",
    role: "doctor",
    status: "active",
    specialization: "Endocrinologist",
    facilityId: null,
    createdAt: now,
  });
}

const careTeam = [doctorId, ...(role === "nurse" ? [me.uid] : [])];
const demoPatients = [
  ["John Doe", "101", "stable", "Aspirin", { bloodPressure: "120/80", heartRate: 72 }],
  ["Jane Smith", "102", "critical", "Paracetamol", { bloodPressure: "110/70", heartRate: 75 }],
  ["Alice Johnson", "103", "stable", "Ibuprofen", { bloodPressure: "130/85", heartRate: 80 }],
  ["Michael Brown", "104", "high", "Metformin", { bloodPressure: "140/90", heartRate: 78 }],
  ["Emily Davis", "105", "moderate", "Amoxicillin", { bloodPressure: "118/76", heartRate: 70 }],
].map(([name, room, priority, nextMed, vitals], i) => ({
  id: `demo-patient-${i + 1}`,
  userId: null,
  name,
  room,
  priority,
  nextMed,
  vitals,
}));
if (role === "patient") {
  demoPatients.unshift({
    id: me.uid,
    userId: me.uid,
    name: me.displayName ?? email,
    room: null,
    priority: "stable",
    nextMed: "Metformin",
    vitals: { bloodPressure: "120/80", heartRate: 72, weight: 68, bloodSugar: 95 },
  });
}

for (const { id, ...p } of demoPatients) {
  batch.set(db.collection("patients").doc(id), { ...p, careTeam, dateOfBirth: null, createdAt: now });
}

const [first, second] = demoPatients;
const appts = [
  [first, day(1), "09:00", "Follow-up", "confirmed", "Regular diabetes check-up"],
  [second, day(2), "14:30", "Consultation", "pending", "Chest pain evaluation"],
  [first, day(7), "10:00", "General Checkup", "pending", null],
];
for (const [p, date, time, type, status, notes] of appts) {
  const scheduledAt = toScheduledAt(date, time);
  const ref = db.collection("appointments").doc();
  batch.set(db.collection("appointmentSlots").doc(`${doctorId}_${scheduledAt.toMillis()}`), {
    appointmentId: ref.id,
  });
  batch.set(ref, {
    patientId: p.id,
    patientUserId: p.userId,
    patientName: p.name,
    doctorId,
    doctorName: role === "doctor" ? me.displayName ?? email : "Dr. James Wilson",
    date,
    time,
    scheduledAt,
    type,
    notes,
    status,
    createdBy: doctorId,
    createdAt: now,
    updatedAt: now,
  });
}

for (const [medication, dosage, frequency] of [
  ["Metformin", "500mg", "Twice daily"],
  ["Lisinopril", "10mg", "Once daily"],
]) {
  batch.set(db.collection("prescriptions").doc(), {
    patientId: first.id,
    patientName: first.name,
    doctorId,
    doctorName: "Dr. James Wilson",
    medication,
    dosage,
    frequency,
    startDate: day(-30),
    endDate: day(60),
    refills: 2,
    notes: null,
    status: "active",
    createdAt: now,
  });
}

batch.set(db.collection("medicalRecords").doc(), {
  patientId: first.id,
  patientName: first.name,
  doctorId,
  doctorName: "Dr. James Wilson",
  type: "Blood Work",
  diagnosis: "Uncontrolled diabetes",
  treatment: "Adjusted medication",
  results: "Elevated blood sugar levels",
  recommendations: "Adjust medication dosage",
  appointmentId: null,
  status: "final",
  createdAt: Timestamp.fromDate(new Date(Date.now() - 14 * 86400e3)),
});

for (const [title, description, type, priority] of [
  ["Welcome to CureCloud", "Your demo data is ready.", "system", "normal"],
  ["Upcoming appointment", `Follow-up on ${day(1)} at 09:00`, "appointment", "important"],
]) {
  batch.set(db.collection("notifications").doc(), {
    userId: me.uid,
    title,
    description,
    type,
    priority,
    read: false,
    createdAt: now,
  });
}

await batch.commit();
console.log(`Seeded emulator data for ${email} as ${role}.`);
