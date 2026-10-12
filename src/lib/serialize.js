import { Timestamp } from "firebase-admin/firestore";

// Firestore Timestamps → ISO strings, recursively, so responses are plain JSON.
export function toJson(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  }
  return value;
}

// Snapshot → { id, ...data } with ISO timestamps. Hidden fields are removed later by redact().
export const serialize = (snap) => ({ id: snap.id, ...toJson(snap.data()) });

// Snapshot → { id, ...data } keeping Firestore types, for policy checks and writes.
export const raw = (snap) => (snap.exists ? { id: snap.id, ...snap.data() } : null);
