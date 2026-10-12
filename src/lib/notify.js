// Writes a notification inside an existing transaction or batch (docs/domain-model.md §2.13).
// No-op for patients without an account. Text must not carry clinical detail beyond what the
// recipient can already see.
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { NOTIFICATION_TTL_DAYS } from "../models/notification.js";

export function notify(writer, userId, { title, description, type, priority = "normal", resource = null }) {
  if (!userId) return;
  const now = FieldValue.serverTimestamp();
  writer.set(db.collection("notifications").doc(), {
    userId,
    type,
    title: title.slice(0, 120),
    description: description.slice(0, 500),
    priority,
    resource,
    read: false,
    readAt: null,
    expiresAt: Timestamp.fromMillis(Date.now() + NOTIFICATION_TTL_DAYS * 86400e3),
    createdAt: now,
    createdBy: "system",
    updatedAt: now,
    updatedBy: "system",
    schemaVersion: 2,
  });
}
