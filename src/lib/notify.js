import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase.js";

// Writes a notification inside an existing transaction/batch. No-op for patients without an account.
export function notify(writer, userId, { title, description, type, priority = "normal" }) {
  if (!userId) return;
  writer.set(db.collection("notifications").doc(), {
    userId,
    title,
    description,
    type,
    priority,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  });
}
