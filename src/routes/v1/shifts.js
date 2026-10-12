// Shifts, the roster and handover notes (docs/domain-model.md §2.12, §4.2 "Care tasks and shifts").
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebase.js";
import { authorize, can, getDoc, isStaff, queries, redact, scoped, systemAdmin } from "../../authz/index.js";
import { writeAudit } from "../../lib/audit.js";
import { DAY, HOUR, addMs, startOfSastDay, toDate } from "../../lib/dates.js";
import { fetchAll, fetchInTx, paginate } from "../../lib/firestore-query.js";
import { badRequest, conflict, fieldForbidden, forbidden, invalidTransition } from "../../lib/problem.js";
import { defineRoute } from "../../lib/route.js";
import { raw, serialize, toJson } from "../../lib/serialize.js";
import { createdFields, sendCreated, updatedFields } from "../../lib/write.js";
import {
  CurrentShift,
  MAX_SHIFT_HOURS,
  Shift,
  ShiftCreateRequest,
  ShiftListQuery,
  ShiftPage,
  ShiftUpdateRequest,
  idParam,
} from "../../models/index.js";

const shifts = db.collection("shifts");
const MANAGE_FIELDS = ["type", "start", "end", "departmentId", "status"];

const onDuty = (s, now) =>
  s.status === "scheduled" && s.type !== "leave" && toDate(s.start) <= now && toDate(s.end) > now;

function checkWindow(start, end) {
  if (end <= start) throw badRequest("end must be after start");
  if (end - start > MAX_SHIFT_HOURS * HOUR) throw badRequest(`A shift can be at most ${MAX_SHIFT_HOURS} hours long`);
}

// No two scheduled shifts of the same staff member may overlap (409 conflict).
async function checkOverlap(tx, staffId, start, end, ignoreId) {
  const existing = await fetchInTx(tx, queries.staffShifts(staffId, start, end));
  const overlaps = existing.some((d) => {
    const s = d.data();
    return d.id !== ignoreId && s.status === "scheduled" && toDate(s.start) < end && toDate(s.end) > start;
  });
  if (overlaps) throw conflict("The shift overlaps an existing shift");
}

async function loadDepartmentIn(facilityId, departmentId) {
  const dept = await getDoc("departments", departmentId);
  if (!dept || dept.facilityId !== facilityId) throw badRequest("departmentId must be a department of the staff member's facility");
  return dept;
}

export function register(router) {
  defineRoute(router, {
    method: "get",
    path: "/shifts",
    permission: "shift:read",
    summary: "The roster for a window, sorted by start",
    description:
      "Scoped to the caller's facility. staffId accepts me. System admins must pass facilityId, departmentId or staffId (400 otherwise); facilityId is for system admins only. Window at most 31 days (default: today plus 7 days). handoverNote is visible only to the owner and to doctors and nurses of the same department.",
    tags: ["Shifts"],
    request: { query: ShiftListQuery },
    responses: { 200: ShiftPage },
    async handler(req, res) {
      const user = req.user;
      const { limit, cursor, from: f, to: t, ...filters } = req.valid.query;
      const from = f ? new Date(f) : startOfSastDay();
      const to = t ? new Date(t) : addMs(from, 7 * DAY);
      if (to <= from) throw badRequest("to must be after from");
      if (to - from > 31 * DAY) throw badRequest("The window can be at most 31 days");
      const ctx = {};
      const inScope = (doc) => doc && (systemAdmin(user) || (user.facilityId && doc.facilityId === user.facilityId));
      if (filters.staffId && filters.staffId !== "me" && filters.staffId !== user.id) {
        const staff = await getDoc("users", filters.staffId);
        if (!inScope(staff)) throw forbidden("staffId must be in your facility");
        ctx.staffId = staff.id;
      }
      if (filters.departmentId) {
        const dept = await getDoc("departments", filters.departmentId);
        if (!inScope(dept)) throw forbidden("departmentId must be in your facility");
        ctx.departmentId = dept.id;
      }
      const page = await paginate(scoped.shifts(user, { ...filters, from, to }, ctx), { limit, cursor });
      res.json({ data: page.docs.map((d) => redact(user, "shift", serialize(d))), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/shifts/current",
    permission: "shift:read",
    summary: "The caller's current shift, the previous handover and who is on duty",
    description: "Same department, not paginated. previousHandover is never returned to admins.",
    tags: ["Shifts"],
    responses: { 200: CurrentShift },
    async handler(req, res) {
      res.json(await currentShift(req.user));
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/shifts",
    permission: "shift:manage",
    summary: "Add a shift or leave to the roster",
    description:
      "The staff member must be active and pass facility for the caller (system admins: any facility). The shift's facilityId is the staff member's facility and departmentId must be one of its departments. 409 conflict on overlap.",
    tags: ["Shifts"],
    request: { body: ShiftCreateRequest },
    responses: { 201: Shift },
    problems: ["409"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const staff = await getDoc("users", body.staffId);
      const inFacility = staff?.facilityId && (systemAdmin(user) || staff.facilityId === user.facilityId);
      if (!staff || staff.role === "patient" || staff.status !== "active" || !inFacility) {
        throw badRequest("staffId must be an active staff member in your facility");
      }
      const start = new Date(body.start);
      const end = new Date(body.end);
      checkWindow(start, end);
      const departmentId = body.departmentId ?? staff.departmentId ?? null;
      if (departmentId) await loadDepartmentIn(staff.facilityId, departmentId);
      const ref = shifts.doc();
      await db.runTransaction(async (tx) => {
        await checkOverlap(tx, staff.id, start, end);
        tx.create(ref, {
          staffId: staff.id,
          staffName: staff.name,
          staffRole: staff.role,
          facilityId: staff.facilityId,
          departmentId,
          type: body.type,
          start: Timestamp.fromDate(start),
          end: Timestamp.fromDate(end),
          status: "scheduled",
          handoverNote: null,
          handoverAt: null,
          ...createdFields(user),
        });
        writeAudit(tx, user, { action: "create", resource: { type: "shift", id: ref.id }, changedFields: Object.keys(body) });
      });
      sendCreated(res, `/shifts/${ref.id}`, redact(user, "shift", serialize(await ref.get())));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/shifts/{id}",
    permission: ["shift:manage", "shift:handover"],
    summary: "Edit or cancel a shift (admins) or write the handover note (shift owner)",
    description: "Only the owner of a doctor or nurse shift writes handoverNote; admins never do (403).",
    tags: ["Shifts"],
    request: { params: idParam, body: ShiftUpdateRequest },
    responses: { 200: Shift },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const shift = await getDoc("shifts", req.valid.params.id);
      authorize(user, "shift:read", shift);
      const managed = MANAGE_FIELDS.filter((k) => body[k] !== undefined);
      if (managed.length && !can(user, "shift:manage", shift)) throw fieldForbidden(managed[0]);
      if (body.handoverNote !== undefined && !can(user, "shift:handover", shift)) {
        throw forbidden("Only the shift owner can write the handover note");
      }
      if (shift.status === "cancelled") throw invalidTransition("The shift is cancelled");

      const update = { ...updatedFields(user) };
      if (body.type) update.type = body.type;
      if (body.status) update.status = body.status;
      if (body.departmentId !== undefined) {
        if (body.departmentId) await loadDepartmentIn(shift.facilityId, body.departmentId);
        update.departmentId = body.departmentId;
      }
      if (body.handoverNote !== undefined) Object.assign(update, { handoverNote: body.handoverNote, handoverAt: Timestamp.now() });
      const start = body.start ? new Date(body.start) : toDate(shift.start);
      const end = body.end ? new Date(body.end) : toDate(shift.end);
      const retimed = body.start !== undefined || body.end !== undefined;
      if (retimed) {
        checkWindow(start, end);
        Object.assign(update, { start: Timestamp.fromDate(start), end: Timestamp.fromDate(end) });
      }
      const ref = shifts.doc(shift.id);
      await db.runTransaction(async (tx) => {
        if (retimed) await checkOverlap(tx, shift.staffId, start, end, shift.id);
        tx.update(ref, update);
        writeAudit(tx, user, {
          action: body.status ? "status-change" : "update",
          resource: { type: "shift", id: shift.id },
          changedFields: Object.keys(body),
        });
      });
      res.json(redact(user, "shift", serialize(await ref.get())));
    },
  });
}

// Shared with the nurse dashboard.
export async function currentShift(user, now = new Date()) {
  const soon = addMs(now, 1);
  const mine = (await fetchAll(queries.staffShifts(user.id, now, soon))).map(raw).find((s) => onDuty(s, now)) ?? null;
  const departmentId = mine?.departmentId ?? user.departmentId ?? null;

  let previousHandover = null;
  if (isStaff(user) && departmentId) {
    const previous = (await fetchAll(queries.previousShifts(departmentId, now), { limit: 10 })).map(raw);
    const last = previous.find((s) => s.handoverNote && s.status === "scheduled" && s.id !== mine?.id);
    if (last) previousHandover = { note: last.handoverNote, staffName: last.staffName, at: toJson(last.handoverAt ?? last.end) };
  }

  let colleagues = [];
  if (departmentId) colleagues = await fetchAll(queries.departmentShifts(departmentId, now, soon));
  else if (user.facilityId) colleagues = await fetchAll(queries.facilityShifts(user.facilityId, now, soon));
  const seen = new Set();
  const duty = colleagues
    .map(raw)
    .filter((s) => onDuty(s, now) && !seen.has(s.staffId) && seen.add(s.staffId))
    .map((s) => ({ staffId: s.staffId, staffName: s.staffName, staffRole: s.staffRole, type: s.type }));

  return { shift: mine ? redact(user, "shift", toJson(mine)) : null, previousHandover, onDuty: duty };
}
