// Load + authorize helpers: get a document, then apply the relationship rules of §3.3 so hidden
// resources surface as 404 and visible-but-forbidden actions as 403.
import { db } from "../firebase.js";
import { notFound } from "../lib/problem.js";
import { raw } from "../lib/serialize.js";
import { authorize } from "./policy.js";

export const getDoc = async (collection, id) => raw(await db.collection(collection).doc(id).get());

export async function loadPatient(user, patientId, permission = "patient:read") {
  const patient = await getDoc("patients", patientId);
  return authorize(user, permission, patient, {}, { what: "patient" });
}

// The caller's own patient record. patients/{uid} by convention, but the link is patient.userId.
export async function ownPatient(user) {
  const byId = await getDoc("patients", user.id);
  if (byId?.userId === user.id) return byId;
  const snap = await db.collection("patients").where("userId", "==", user.id).limit(1).get();
  return snap.empty ? null : raw(snap.docs[0]);
}

// For patient-scoped list filters: patients are pinned to their own record (another patientId is
// not visible → 404); staff must have self/clinical access to the named patient.
export async function resolvePatientFilter(user, patientId, permission) {
  if (user.role === "patient") {
    const own = await ownPatient(user);
    if (!own || (patientId && patientId !== own.id)) throw notFound("patient");
    return own;
  }
  if (!patientId) return null;
  const patient = await loadPatient(user, patientId, "patient:read");
  if (permission) authorize(user, permission, {}, { patient }, { what: "patient" });
  return patient;
}

// Loads the patients behind a list of resources (deduplicated getAll), keyed by ID.
export async function patientsById(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const snaps = await db.getAll(...unique.map((id) => db.collection("patients").doc(id)));
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, raw(s)]));
}
