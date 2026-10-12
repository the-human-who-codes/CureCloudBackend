// Notification (§2.13): per-user inbox written only by the server.
import { ResourceRef, auditFields, booleanQuery, id, isoTimestamp, listQuery, opt, page, storedMeta, storedTimestamp } from "./common.js";
import { z } from "./zod.js";

export const NOTIFICATION_TYPES = [
  "appointment",
  "prescription",
  "medical-record",
  "care-task",
  "message",
  "account",
  "system",
];
export const NOTIFICATION_TTL_DAYS = 90;

const shape = (ts) => ({
  userId: id,
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string().max(120),
  description: z.string().max(500),
  priority: z.enum(["normal", "important"]),
  resource: opt(ResourceRef),
  read: z.boolean(),
  readAt: opt(ts),
  ...auditFields(ts),
});

export const NotificationStored = z.object({ ...shape(storedTimestamp), ...storedMeta, expiresAt: storedTimestamp });
export const Notification = z.object({ id, ...shape(isoTimestamp) }).openapi("Notification");
export const NotificationPage = page(Notification, "NotificationPage");

export const NotificationListQuery = listQuery.extend({ unread: booleanQuery.optional() }).strict();
export const NotificationUpdateRequest = z.object({ read: z.literal(true) }).strict().openapi("NotificationUpdateRequest");
export const UnreadCount = z.object({ count: z.number().int() }).openapi("UnreadCount");
export const ReadAllResponse = z.object({ updated: z.number().int() }).openapi("ReadAllResponse");
