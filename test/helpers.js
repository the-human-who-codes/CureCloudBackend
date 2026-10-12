import request from "supertest";
import { Timestamp } from "firebase-admin/firestore";
import { app } from "../src/app.js";
import { auth, db } from "../src/firebase.js";
import { LICENCE_BODIES } from "../src/models/index.js";

const PROJECT = process.env.GCLOUD_PROJECT;
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;

if (!AUTH_HOST || !FIRESTORE_HOST || !PROJECT?.startsWith("demo-")) {
  throw new Error("Tests must run against emulators with a demo- project (npm test)");
}

export const api = () => request(app);
export const V1 = "/api/v1";

export async function resetEmulators() {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
    method: "DELETE",
  });
  await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
}

export async function signIn(email, password = "password123") {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = await res.json();
  if (!body.idToken) throw new Error(`Sign-in failed for ${email}: ${JSON.stringify(body)}`);
  return body.idToken;
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// Thin client: as(token).get("/patients") etc., all under /api/v1.
export function as(token) {
  const call = (method) => (path, body) => {
    const req = api()[method](`${V1}${path}`).set(bearer(token));
    return body === undefined ? req : req.send(body);
  };
  return { get: call("get"), post: call("post"), patch: call("patch"), delete: call("delete") };
}

// Simulates a Google sign-in: an Auth account with a verified email and no Firestore profile.
export async function googleUser(email, name) {
  const { uid } = await auth.createUser({ email, password: "password123", emailVerified: true, displayName: name });
  return { uid, token: await signIn(email) };
}

const audit = (uid) => ({
  createdAt: Timestamp.now(),
  createdBy: uid,
  updatedAt: Timestamp.now(),
  updatedBy: uid,
  schemaVersion: 2,
});

export async function seedFacility(id = "f1", name = "Chris Hani Baragwanath") {
  await db.collection("facilities").doc(id).set({ name, type: "hospital", status: "active", address: null, phone: null, email: null, ...audit("system") });
}

export async function seedDepartment(id, facilityId, name, bedCapacity = 20) {
  await db.collection("departments").doc(id).set({
    facilityId,
    name,
    nameLower: name.toLowerCase(),
    headId: null,
    headName: null,
    location: null,
    phone: null,
    bedCapacity,
    status: "active",
    ...audit("system"),
  });
}

// Creates an already-approved account directly in Firestore (v2 shape).
export async function staffUser(email, role, extra = {}) {
  const { uid } = await auth.createUser({ email, password: "password123", emailVerified: true });
  const name = extra.name ?? email.split("@")[0];
  await db
    .collection("users")
    .doc(uid)
    .set({
      email,
      name,
      nameLower: name.toLowerCase(),
      role,
      status: "active",
      facilityId: null,
      departmentId: null,
      phone: null,
      identifier: null,
      emergencyContact: null,
      practitioner: LICENCE_BODIES[role] ? { licenceBody: LICENCE_BODIES[role], licenceNumber: "MP0123456", qualifications: [] } : null,
      ...audit(uid),
      ...extra,
    });
  return { uid, token: await signIn(email) };
}

// A future SAST weekday at HH:mm, `days` or more days ahead, as an instant with offset.
export function weekdaySlot(days, time = "09:00") {
  for (let d = days; ; d++) {
    const date = new Date(Date.now() + 2 * 3600e3 + d * 86400e3);
    const weekday = date.getUTCDay();
    if (weekday >= 1 && weekday <= 5) return `${date.toISOString().slice(0, 10)}T${time}:00+02:00`;
  }
}

// YYYY-MM-DD `days` from today (SAST).
export function sastDay(days = 0) {
  return new Date(Date.now() + 2 * 3600e3 + days * 86400e3).toISOString().slice(0, 10);
}

export const ts = (date) => Timestamp.fromDate(new Date(date));
export { audit, db, auth };
