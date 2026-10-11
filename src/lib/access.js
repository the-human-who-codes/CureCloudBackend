import { db } from "../firebase.js";
import { serialize, notFound, badRequest } from "./http.js";

export function canAccessPatient(user, patient) {
  if (user.role === "admin") return true;
  if (user.role === "patient") return patient.userId === user.id;
  return (patient.careTeam ?? []).includes(user.id);
}

// Returns 404 (not 403) for inaccessible patients so IDs can't be probed.
export async function getAccessiblePatient(user, patientId) {
  const snap = await db.collection("patients").doc(patientId).get();
  if (!snap.exists) throw notFound("Patient");
  const patient = serialize(snap);
  if (!canAccessPatient(user, patient)) throw notFound("Patient");
  return patient;
}

// Patients are always scoped to themselves; staff must name a patient they can access.
export async function resolvePatientId(user, requestedPatientId, { required = true } = {}) {
  if (user.role === "patient") return user.id;
  if (!requestedPatientId) {
    if (required) throw badRequest("patientId is required");
    return null;
  }
  await getAccessiblePatient(user, requestedPatientId);
  return requestedPatientId;
}
