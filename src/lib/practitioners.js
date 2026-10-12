// PractitionerSummary projection (docs/domain-model.md §2.2). Facility and department names are
// resolved per request with getAll.
import { db } from "../firebase.js";
import { redact } from "../authz/index.js";

export async function practitionerSummaries(caller, users) {
  const facilityIds = [...new Set(users.map((u) => u.facilityId).filter(Boolean))];
  const departmentIds = [...new Set(users.map((u) => u.departmentId).filter(Boolean))];
  const [facilities, departments] = await Promise.all([
    facilityIds.length ? db.getAll(...facilityIds.map((id) => db.collection("facilities").doc(id))) : [],
    departmentIds.length ? db.getAll(...departmentIds.map((id) => db.collection("departments").doc(id))) : [],
  ]);
  const names = new Map([...facilities, ...departments].filter((s) => s.exists).map((s) => [s.ref.path, s.get("name")]));
  return users.map((u) =>
    redact(caller, "practitionerSummary", {
      id: u.id,
      name: u.name,
      role: u.role,
      email: u.email,
      specialization: u.practitioner?.specialization ?? null,
      photoUrl: u.photoUrl ?? null,
      facilityId: u.facilityId ?? null,
      facilityName: (u.facilityId && names.get(`facilities/${u.facilityId}`)) ?? null,
      departmentId: u.departmentId ?? null,
      departmentName: (u.departmentId && names.get(`departments/${u.departmentId}`)) ?? null,
    }),
  );
}
