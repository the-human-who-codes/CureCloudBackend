// The v1 → v2 data migration (docs/domain-model.md §6), separate from the CLI so tests can run it
// against the emulator. Idempotent: documents with schemaVersion >= 2 are skipped, missing slot locks
// are only created when absent, and the fallback facility only when no facility exists.
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  DELETE,
  changedFields,
  missingSlotLocks,
  transformAppointment,
  transformMedicalRecord,
  transformNotification,
  transformPatient,
  transformPrescription,
  transformPreferences,
  transformSlot,
  transformUser,
  transformVitals,
} from "./v1-transforms.js";

export const DEFAULT_FACILITY_ID = "default";
const BATCH_LIMIT = 400;
const SAMPLES = 5;

// Collects writes into batches of at most 400 and commits them only when applying.
class Writer {
  constructor(db, apply) {
    this.db = db;
    this.apply = apply;
    this.batch = db.batch();
    this.ops = 0;
  }

  async add(ops, fn) {
    if (!this.apply) return;
    if (this.ops + ops > BATCH_LIMIT) await this.flush();
    fn(this.batch);
    this.ops += ops;
  }

  async flush() {
    if (this.apply && this.ops) await this.batch.commit();
    this.batch = this.db.batch();
    this.ops = 0;
  }
}

const toFirestore = (update) =>
  Object.fromEntries(Object.entries(update).map(([k, v]) => [k, v === DELETE ? FieldValue.delete() : v]));

// The migrated document as later transforms see it (DELETE removes the field).
const merged = (doc, update) => {
  const out = { ...doc };
  for (const [k, v] of Object.entries(update)) {
    if (k.includes(".")) continue;
    if (v === DELETE) delete out[k];
    else out[k] = v;
  }
  return out;
};

// The facility migrated documents fall back to: the requested ID (which must exist once any facility
// does), facilities/default when there is none yet, or the only existing one. Several facilities and
// no --default-facility-id abort the run before anything is written.
export function resolveDefaultFacility(existingIds, requested) {
  if (!existingIds.length) return requested ?? DEFAULT_FACILITY_ID;
  if (requested) {
    if (!existingIds.includes(requested)) throw new Error(`Facility ${requested} does not exist`);
    return requested;
  }
  if (existingIds.length === 1) return existingIds[0];
  throw new Error(
    `${existingIds.length} facilities exist; pass --default-facility-id <id> to choose the fallback facility`,
  );
}

const docsOf = (snap) => snap.docs.map((d) => ({ ref: d.ref, doc: { id: d.id, ...d.data() } }));

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {{ apply?: boolean, defaultFacilityId?: string, defaultFacilityName?: string, now?: Timestamp }} options
 * @returns {Promise<{ apply: boolean, defaultFacilityId: string, collections: Record<string, { scanned: number, migrated: number, samples: { id: string, fields: string[] }[] }> }>}
 */
export async function runMigration(
  db,
  { apply = false, defaultFacilityId: requestedFacilityId, defaultFacilityName = "CureCloud Demo Hospital", now = Timestamp.now() } = {},
) {
  const writer = new Writer(db, apply);
  const report = { apply, collections: {} };
  const stats = (name) => (report.collections[name] ??= { scanned: 0, migrated: 0, samples: [] });

  const audit = (batch, resource, fields, patientId = null) =>
    batch.set(db.collection("auditEvents").doc(), {
      at: now,
      actorId: "system",
      actorRole: "system",
      action: "update",
      resource,
      patientId,
      changedFields: fields,
      schemaVersion: 2,
    });

  // Applies a transform result: one update plus one audit event (2 writes).
  async function migrate(name, ref, doc, update, resource, patientId) {
    const s = stats(name);
    s.scanned++;
    if (!update) return;
    s.migrated++;
    const fields = changedFields(update);
    if (s.samples.length < SAMPLES) s.samples.push({ id: doc.id, fields });
    await writer.add(resource ? 2 : 1, (batch) => {
      batch.update(ref, toFirestore(update));
      if (resource) audit(batch, resource, fields, patientId);
    });
  }

  // 1. The fallback facility for staff, patients with a care team and appointments without one:
  // created when no facility exists yet, otherwise an existing one (see resolveDefaultFacility).
  const existing = await db.collection("facilities").select().get();
  const facilities = stats("facilities");
  facilities.scanned = existing.size;
  const defaultFacilityId = resolveDefaultFacility(existing.docs.map((d) => d.id), requestedFacilityId);
  report.defaultFacilityId = defaultFacilityId;
  if (existing.empty) {
    facilities.migrated++;
    facilities.samples.push({ id: defaultFacilityId, fields: ["name", "type", "status"] });
    await writer.add(2, (batch) => {
      batch.create(db.collection("facilities").doc(defaultFacilityId), {
        name: defaultFacilityName,
        type: "hospital",
        address: null,
        phone: null,
        email: null,
        status: "active",
        createdAt: now,
        createdBy: "system",
        updatedAt: now,
        updatedBy: "system",
        schemaVersion: 2,
      });
      audit(batch, { type: "facility", id: defaultFacilityId }, ["name", "type", "status"]);
    });
  }

  // Context reads come first and use the stored (pre-migration) documents, so contact data can
  // move from users to patients. Patients migrate before users for the same reason: a re-run after
  // a partial failure never reads a user whose phone was already moved to legacy.
  const users = docsOf(await db.collection("users").get());
  const ctx = {
    now,
    defaultFacilityId,
    users: new Map(users.map(({ doc }) => [doc.id, doc])),
    patients: new Map(),
  };

  // 2. Patients, then their vitals panels.
  for (const { ref, doc } of docsOf(await db.collection("patients").get())) {
    const update = transformPatient(doc, ctx);
    ctx.patients.set(doc.id, update ? merged(doc, update) : doc);
    await migrate("patients", ref, doc, update, { type: "patient", id: doc.id }, doc.id);
  }
  for (const snap of (await db.collectionGroup("vitals").get()).docs) {
    const patientId = snap.ref.parent.parent.id;
    const doc = { id: snap.id, ...snap.data() };
    await migrate("vitals", snap.ref, doc, transformVitals(doc, { ...ctx, patientId }), { type: "vitals", id: snap.id }, patientId);
  }

  // 3. Users.
  for (const { ref, doc } of users) {
    await migrate("users", ref, doc, transformUser(doc, ctx), { type: "user", id: doc.id });
  }

  // 4. Appointments, then their slot locks.
  const appointments = [];
  for (const { ref, doc } of docsOf(await db.collection("appointments").get())) {
    const update = transformAppointment(doc, ctx);
    appointments.push(update ? merged(doc, update) : doc);
    await migrate("appointments", ref, doc, update, { type: "appointment", id: doc.id }, doc.patientId ?? null);
  }
  const slotIds = new Set();
  for (const { ref, doc } of docsOf(await db.collection("appointmentSlots").get())) {
    slotIds.add(doc.id);
    await migrate("appointmentSlots", ref, doc, transformSlot(doc), null); // lock ephemera: not audited
  }
  const locks = stats("appointmentSlots (missing locks)");
  for (const appointment of appointments) {
    for (const lock of missingSlotLocks(appointment)) {
      locks.scanned++;
      if (slotIds.has(lock.id)) continue;
      slotIds.add(lock.id);
      locks.migrated++;
      if (locks.samples.length < SAMPLES) locks.samples.push({ id: lock.id, fields: ["doctorId", "start", "appointmentId"] });
      await writer.add(1, (batch) => batch.create(db.collection("appointmentSlots").doc(lock.id), lock.data));
    }
  }

  // 5. Prescriptions, medical records, notifications and preferences.
  const simple = [
    ["prescriptions", transformPrescription, "prescription"],
    ["medicalRecords", transformMedicalRecord, "medical-record"],
    ["notifications", transformNotification, "notification"],
    ["userPreferences", transformPreferences, "user-preferences"],
  ];
  for (const [collection, transform, type] of simple) {
    for (const { ref, doc } of docsOf(await db.collection(collection).get())) {
      await migrate(collection, ref, doc, transform(doc, ctx), { type, id: doc.id }, doc.patientId ?? null);
    }
  }

  await writer.flush();
  return report;
}

// Human-readable report: counts per collection and sample diffs with IDs and field names only (no PHI).
export function formatReport(report) {
  const lines = [report.apply ? "Applied migration:" : "Dry run (pass --apply to write):"];
  lines.push(`  fallback facility: ${report.defaultFacilityId}`);
  for (const [name, s] of Object.entries(report.collections)) {
    lines.push(`  ${name}: ${s.migrated} to migrate of ${s.scanned} scanned`);
    for (const sample of s.samples) lines.push(`    - ${sample.id}: ${sample.fields.join(", ") || "(schema stamp only)"}`);
  }
  return lines.join("\n");
}
