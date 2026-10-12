// Append-only write audit (docs/domain-model.md §2.20). Adds an auditEvents document to the caller's
// transaction or batch and never writes on its own. changedFields are field names, never values.
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase.js";

export function writeAudit(writer, actor, { action, resource, patientId = null, changedFields = [] }) {
  writer.set(db.collection("auditEvents").doc(), {
    at: FieldValue.serverTimestamp(),
    actorId: actor?.id ?? "system",
    actorRole: actor?.role ?? "system",
    action,
    resource,
    patientId,
    changedFields: [...new Set(changedFields)].sort(),
    schemaVersion: 2,
  });
}
