// Per-user notifications (docs/domain-model.md §2.13, §4.2 "Notifications").
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebase.js";
import { authorize, getDoc, queries, redact, scoped } from "../../authz/index.js";
import { count, fetchAll, paginate } from "../../lib/firestore-query.js";
import { defineRoute } from "../../lib/route.js";
import { serialize } from "../../lib/serialize.js";
import { updatedFields } from "../../lib/write.js";
import {
  Notification,
  NotificationListQuery,
  NotificationPage,
  NotificationUpdateRequest,
  ReadAllResponse,
  UnreadCount,
  idParam,
} from "../../models/index.js";

const notifications = db.collection("notifications");

export function register(router) {
  defineRoute(router, {
    method: "get",
    path: "/notifications",
    permission: "notification:read",
    summary: "The caller's notifications, newest first",
    tags: ["Notifications"],
    request: { query: NotificationListQuery },
    responses: { 200: NotificationPage },
    async handler(req, res) {
      const { limit, cursor, ...filters } = req.valid.query;
      const page = await paginate(scoped.notifications(req.user, filters), { limit, cursor });
      res.json({ data: page.docs.map((d) => redact(req.user, "notification", serialize(d))), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/notifications/unread-count",
    permission: "notification:read",
    summary: "Number of unread notifications (for the header badge)",
    tags: ["Notifications"],
    responses: { 200: UnreadCount },
    async handler(req, res) {
      res.json({ count: await count(queries.unreadNotifications(req.user.id)) });
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/notifications/{id}",
    permission: "notification:update",
    summary: "Mark a notification read",
    tags: ["Notifications"],
    request: { params: idParam, body: NotificationUpdateRequest },
    responses: { 200: Notification },
    problems: ["404"],
    async handler(req, res) {
      const n = authorize(req.user, "notification:update", await getDoc("notifications", req.valid.params.id));
      const ref = notifications.doc(n.id);
      if (!n.read) await ref.update({ read: true, readAt: Timestamp.now(), ...updatedFields(req.user) });
      res.json(redact(req.user, "notification", serialize(await ref.get())));
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/notifications/read-all",
    permission: "notification:update",
    summary: "Mark every unread notification read",
    tags: ["Notifications"],
    responses: { 200: ReadAllResponse },
    async handler(req, res) {
      const docs = await fetchAll(queries.unreadNotifications(req.user.id), { limit: 500 }); // batch write limit
      const batch = db.batch();
      const now = Timestamp.now();
      for (const d of docs) batch.update(d.ref, { read: true, readAt: now, ...updatedFields(req.user) });
      if (docs.length) await batch.commit();
      res.json({ updated: docs.length });
    },
  });
}
