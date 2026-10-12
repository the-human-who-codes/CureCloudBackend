// Audit fields (docs/domain-model.md §1.3) for writes. The server sets them and ignores them in bodies.
import { FieldValue } from "firebase-admin/firestore";
import { SCHEMA_VERSION } from "../models/common.js";

const actorId = (actor) => actor?.id ?? "system";

export function createdFields(actor) {
  const now = FieldValue.serverTimestamp();
  return { createdAt: now, createdBy: actorId(actor), updatedAt: now, updatedBy: actorId(actor), schemaVersion: SCHEMA_VERSION };
}

export const updatedFields = (actor) => ({ updatedAt: FieldValue.serverTimestamp(), updatedBy: actorId(actor) });

// Optional request fields become explicit nulls in stored documents.
export const orNull = (v) => (v === undefined ? null : v);

export const nameLower = (name) => name.trim().toLowerCase();

// 201 with a Location header (§1.7).
export const sendCreated = (res, location, body) => res.status(201).location(`/api/v1${location}`).json(body);
