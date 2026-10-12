// Account management and the practitioner directory (docs/domain-model.md §2.1, §2.2,
// §4.2 "Users, directory, organisation").
import { auth, db } from "../../firebase.js";
import { authorize, getDoc, queries, redact, scoped, systemAdmin } from "../../authz/index.js";
import { writeAudit } from "../../lib/audit.js";
import { fetchInTx, paginate } from "../../lib/firestore-query.js";
import { notify } from "../../lib/notify.js";
import { practitionerSummaries } from "../../lib/practitioners.js";
import { badRequest, conflict, fieldForbidden, forbidden, invalidTransition } from "../../lib/problem.js";
import { defineRoute } from "../../lib/route.js";
import { raw, toJson } from "../../lib/serialize.js";
import { updatedFields } from "../../lib/write.js";
import {
  LICENCE_BODIES,
  PractitionerListQuery,
  PractitionerSummaryPage,
  STAFF_ROLES,
  User,
  UserListQuery,
  UserPage,
  UserUpdateRequest,
  idParam,
} from "../../models/index.js";

const users = db.collection("users");
const CONTROL_FIELDS = ["role", "status", "facilityId", "departmentId"];
const STATUS_TRANSITIONS = { pending: ["active", "disabled"], active: ["disabled"], disabled: ["active"] };
const isStaffRole = (role) => STAFF_ROLES.includes(role);

// lastSignInAt is not stored; it comes from Firebase Auth metadata on admin reads.
async function lastSignIns(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const result = await auth.getUsers(ids.slice(i, i + 100).map((uid) => ({ uid })));
    for (const record of result.users) {
      const at = record.metadata.lastSignInTime;
      out.set(record.uid, at ? new Date(at).toISOString() : null);
    }
  }
  return out;
}

async function userResponses(caller, docs) {
  const signIns = caller.role === "admin" ? await lastSignIns(docs.map((d) => d.id)) : new Map();
  return docs.map((u) => redact(caller, "user", { ...toJson(u), lastSignInAt: signIns.get(u.id) ?? null }));
}

export function register(router) {
  defineRoute(router, {
    method: "get",
    path: "/users",
    permission: "user:list",
    summary: "Admin user list, sorted by name",
    description:
      "System admins: everyone (or ?facilityId=). Facility admins: staff and admins of their facility plus pending unassigned staff; role=patient returns 403. q is a case-insensitive name prefix and combines only with role and status.",
    tags: ["Users"],
    request: { query: UserListQuery },
    responses: { 200: UserPage },
    async handler(req, res) {
      const user = req.user;
      const { limit, cursor, ...filters } = req.valid.query;
      const ctx = {};
      if (filters.departmentId && !systemAdmin(user)) {
        const dept = await getDoc("departments", filters.departmentId);
        if (dept?.facilityId !== user.facilityId) throw forbidden("departmentId must be in your facility");
        ctx.departmentId = dept.id;
      }
      const page = await paginate(scoped.users(user, filters, ctx), { limit, cursor });
      res.json({ data: await userResponses(user, page.docs.map(raw)), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/users/{id}",
    permission: "user:read",
    summary: "Get a user account (404 outside the admin's scope)",
    tags: ["Users"],
    request: { params: idParam },
    responses: { 200: User },
    problems: ["404"],
    async handler(req, res) {
      const target = authorize(req.user, "user:read", await getDoc("users", req.valid.params.id), {}, { what: "user" });
      res.json((await userResponses(req.user, [target]))[0]);
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/users/{id}",
    permission: "user:update",
    summary: "Approve, disable, re-role or reassign an account",
    description:
      "Enforces the invariants in §2.1: no self-change of role/status/facilityId/departmentId; only system admins touch admin accounts, patient accounts, role: admin or an admin's facilityId; facility admins manage doctors and nurses of their facility or pending unassigned ones and may only set facilityId to their own; the last active system admin keeps its role, status and null facilityId (409). Activating staff requires facilityId, departmentId for nurses and practitioner.licenceNumber.",
    tags: ["Users"],
    request: { params: idParam, body: UserUpdateRequest },
    responses: { 200: User },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const ref = users.doc(req.valid.params.id);
      const before = await db.runTransaction(async (tx) => {
        const target = raw(await tx.get(ref));
        authorize(user, "user:update", target, {}, { what: "user" });
        const sys = systemAdmin(user);
        const role = body.role ?? target.role;
        const status = body.status ?? target.status;
        const facilityId = body.facilityId !== undefined ? body.facilityId : (target.facilityId ?? null);
        let departmentId = body.departmentId !== undefined ? body.departmentId : (target.departmentId ?? null);

        // Reads first (transactions require all reads before writes).
        const wasActiveSystemAdmin = target.role === "admin" && target.status === "active" && !target.facilityId;
        const losesSystemAdmin = wasActiveSystemAdmin && (role !== "admin" || status !== "active" || facilityId);
        const admins = losesSystemAdmin ? await fetchInTx(tx, queries.activeSystemAdmins(), { limit: 2 }) : [];
        const facility = body.facilityId ? raw(await tx.get(db.collection("facilities").doc(body.facilityId))) : null;
        const department = departmentId ? raw(await tx.get(db.collection("departments").doc(departmentId))) : null;
        const leavesPending = target.status === "pending" && status !== "pending";
        const alerts = leavesPending ? await fetchInTx(tx, queries.openSignupAlerts(target.id)) : [];

        if (losesSystemAdmin && admins.length <= 1) throw conflict("This is the last active system administrator");
        const control = CONTROL_FIELDS.filter((k) => body[k] !== undefined);
        if (target.id === user.id && control.length) throw fieldForbidden(control[0]);
        if (!sys && (target.role === "admin" || role === "admin" || target.role === "patient")) {
          throw forbidden("Only system administrators can manage admin and patient accounts");
        }
        if (target.role === "patient" && body.role) throw badRequest("Patient accounts cannot become staff accounts");
        if (!sys && body.facilityId !== undefined && body.facilityId !== user.facilityId) {
          throw forbidden("You can only assign staff to your own facility");
        }
        if (body.facilityId && (!facility || facility.status !== "active")) throw badRequest("facilityId must be an active facility");
        const departmentTouched = body.departmentId !== undefined || facilityId !== (target.facilityId ?? null);
        if (departmentTouched && departmentId) {
          if (body.departmentId === undefined && department?.facilityId !== facilityId) {
            departmentId = null; // moving facility drops a department of the old facility
          } else if (!department || department.facilityId !== facilityId || department.status !== "active") {
            throw badRequest("departmentId must be an active department of the user's facility");
          }
        }

        let practitioner = target.practitioner ?? null;
        const update = { ...updatedFields(user) };
        if (body.practitioner && !isStaffRole(role)) throw badRequest("practitioner is only for doctors and nurses");
        if (role !== target.role) {
          if (isStaffRole(role) && !body.practitioner?.licenceNumber) {
            throw badRequest("practitioner.licenceNumber is required for the new role (licence numbers are body-specific)");
          }
          if (role === "admin") {
            if (practitioner) update["legacy.practitioner"] = practitioner;
            practitioner = null;
          } else {
            practitioner = { ...(practitioner ?? { qualifications: [] }), licenceBody: LICENCE_BODIES[role] };
          }
        }
        if (body.practitioner) practitioner = { ...practitioner, ...body.practitioner };

        if (body.status && body.status !== target.status) {
          if (!(STATUS_TRANSITIONS[target.status] ?? []).includes(body.status)) {
            throw invalidTransition(`Cannot change status from ${target.status} to ${body.status}`);
          }
          if (target.status === "pending" && body.status === "disabled" && !body.statusReason) {
            throw badRequest("statusReason is required when rejecting a signup");
          }
        }
        if (status === "active" && isStaffRole(role)) {
          if (!facilityId) throw badRequest("facilityId is required to activate staff");
          if (role === "nurse" && !departmentId) throw badRequest("departmentId is required to activate a nurse");
          if (!practitioner?.licenceNumber) throw badRequest("practitioner.licenceNumber is required to activate staff");
        }

        Object.assign(update, { role, status, facilityId, departmentId, practitioner });
        if (body.statusReason !== undefined) update.statusReason = body.statusReason;
        else if (body.status === "active") update.statusReason = null;
        tx.update(ref, update);

        const changed = CONTROL_FIELDS.filter((k) => (update[k] ?? null) !== (target[k] ?? null));
        const licenceChanged =
          practitioner?.licenceNumber !== target.practitioner?.licenceNumber ||
          practitioner?.licenceBody !== target.practitioner?.licenceBody;
        if (changed.length || licenceChanged) {
          writeAudit(tx, user, {
            action: changed.includes("status") ? "status-change" : "update",
            resource: { type: "user", id: target.id },
            changedFields: [...changed, ...(licenceChanged ? ["practitioner"] : [])],
          });
        }
        for (const alert of alerts) {
          tx.update(alert.ref, { status: "resolved", resolvedAt: new Date(), resolvedBy: user.id, ...updatedFields(user) });
        }
        if (target.status !== "active" && status === "active") {
          notify(tx, target.id, {
            title: "Account approved",
            description: "Your CureCloud account is active. You can now sign in.",
            type: "account",
            priority: "important",
          });
        }
        if (target.status !== "disabled" && status === "disabled") {
          notify(tx, target.id, { title: "Account disabled", description: "Your CureCloud account was disabled.", type: "account", priority: "important" });
        }
        return target;
      });

      if (body.status && body.status !== before.status) {
        await auth.updateUser(before.id, { disabled: body.status === "disabled" });
        if (body.status === "disabled") await auth.revokeRefreshTokens(before.id);
      }
      res.json((await userResponses(user, [raw(await ref.get())]))[0]);
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/practitioners",
    permission: "practitioner:list",
    summary: "Directory of active doctors and nurses, sorted by name",
    description: "Patients only see doctors, without email.",
    tags: ["Users"],
    request: { query: PractitionerListQuery },
    responses: { 200: PractitionerSummaryPage },
    async handler(req, res) {
      const { limit, cursor, ...filters } = req.valid.query;
      const page = await paginate(scoped.practitioners(req.user, filters), { limit, cursor });
      res.json({ data: await practitionerSummaries(req.user, page.docs.map(raw)), nextCursor: page.nextCursor });
    },
  });
}
