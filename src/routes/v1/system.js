// System settings and system alerts (docs/domain-model.md §2.16, §2.17).
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebase.js";
import { authorize, getDoc, redact, scoped, systemAdmin } from "../../authz/index.js";
import { paginate } from "../../lib/firestore-query.js";
import { forbidden, invalidTransition } from "../../lib/problem.js";
import { defineRoute } from "../../lib/route.js";
import { serialize, toJson } from "../../lib/serialize.js";
import { deepMerge, getSettings, invalidateSettings, settingsRef, withDefaults } from "../../lib/settings.js";
import { updatedFields } from "../../lib/write.js";
import {
  SystemAlert,
  SystemAlertListQuery,
  SystemAlertPage,
  SystemAlertUpdateRequest,
  SystemSettings,
  SystemSettingsUpdateRequest,
  idParam,
} from "../../models/index.js";

export function register(router) {
  defineRoute(router, {
    method: "get",
    path: "/system-settings",
    permission: "system-settings:read",
    summary: "System settings with defaults filled in",
    tags: ["System"],
    responses: { 200: SystemSettings },
    async handler(_req, res) {
      res.json(toJson(await getSettings()));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/system-settings",
    permission: "system-settings:update",
    summary: "Update system settings (deep merge, system admins only)",
    tags: ["System"],
    request: { body: SystemSettingsUpdateRequest },
    responses: { 200: SystemSettings },
    async handler(req, res) {
      if (!systemAdmin(req.user)) throw forbidden("Only system administrators can change system settings");
      const ref = settingsRef();
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const current = withDefaults(snap.exists ? snap.data() : {});
        const { updatedAt: _ignored, ...merged } = deepMerge(current, req.valid.body);
        tx.set(ref, { ...merged, schemaVersion: 2, ...updatedFields(req.user) });
      });
      invalidateSettings();
      res.json(toJson(await getSettings()));
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/system-alerts",
    permission: "system-alert:read",
    summary: "Operational alerts for the admin's facility, newest first",
    description: "System admins see every alert, including system-wide ones (facilityId null).",
    tags: ["System"],
    request: { query: SystemAlertListQuery },
    responses: { 200: SystemAlertPage },
    async handler(req, res) {
      const { limit, cursor, ...filters } = req.valid.query;
      const page = await paginate(scoped.systemAlerts(req.user, filters), { limit, cursor });
      res.json({ data: page.docs.map((d) => redact(req.user, "system-alert", serialize(d))), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/system-alerts/{id}",
    permission: "system-alert:manage",
    summary: "Resolve an alert",
    tags: ["System"],
    request: { params: idParam, body: SystemAlertUpdateRequest },
    responses: { 200: SystemAlert },
    problems: ["404", "409"],
    async handler(req, res) {
      const alert = authorize(req.user, "system-alert:manage", await getDoc("systemAlerts", req.valid.params.id), {}, { what: "alert" });
      if (alert.status === "resolved") throw invalidTransition("The alert is already resolved");
      const ref = db.collection("systemAlerts").doc(alert.id);
      await ref.update({ status: "resolved", resolvedAt: Timestamp.now(), resolvedBy: req.user.id, ...updatedFields(req.user) });
      res.json(redact(req.user, "system-alert", serialize(await ref.get())));
    },
  });
}
