import request from "supertest";
import { app } from "../src/app.js";
import { auth, db } from "../src/firebase.js";

const PROJECT = process.env.GCLOUD_PROJECT;
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;

if (!AUTH_HOST || !FIRESTORE_HOST || !PROJECT?.startsWith("demo-")) {
  throw new Error("Tests must run against emulators with a demo- project (npm test)");
}

export const api = () => request(app);

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

// Simulates a Google sign-in: an Auth account with a verified email and no Firestore profile.
export async function googleUser(email, name) {
  const { uid } = await auth.createUser({ email, password: "password123", emailVerified: true, displayName: name });
  return { uid, token: await signIn(email) };
}

// Creates an already-approved staff member directly in Firestore.
export async function staffUser(email, role, extra = {}) {
  const { uid } = await auth.createUser({ email, password: "password123", emailVerified: true });
  await db.collection("users").doc(uid).set({ name: email.split("@")[0], email, role, status: "active", ...extra });
  return { uid, token: await signIn(email) };
}

// YYYY-MM-DD `days` from today (SAST).
export function futureDate(days) {
  const d = new Date(Date.now() + 2 * 3600e3 + days * 86400e3);
  return d.toISOString().slice(0, 10);
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });
