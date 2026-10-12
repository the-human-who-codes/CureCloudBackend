// Facilities and departments (docs/domain-model.md §2.3, §2.4).
import { db } from "../../firebase.js";
import { authorize, getDoc, queries, redact, scoped, systemAdmin } from "../../authz/index.js";
import { writeAudit } from "../../lib/audit.js";
import { DAY, addMs, startOfSastDay } from "../../lib/dates.js";
import { count, fetchAll, paginate } from "../../lib/firestore-query.js";
import { badRequest, conflict, forbidden } from "../../lib/problem.js";
import { defineRoute } from "../../lib/route.js";
import { raw, serialize } from "../../lib/serialize.js";
import { createdFields, nameLower, orNull, sendCreated, updatedFields } from "../../lib/write.js";
import {
  Department,
  DepartmentCreateRequest,
  DepartmentListQuery,
  DepartmentPage,
  DepartmentUpdateRequest,
  FacilityListQuery,
  FacilityPage,
  idParam,
} from "../../models/index.js";

const departments = db.collection("departments");

// DepartmentStats (§2.4) from count() aggregations.
export async function departmentStats(dept) {
  const today = startOfSastDay();
  const [staff, doctors, nurses, admittedPatients, appointmentsToday] = await Promise.all([
    count(queries.departmentStaff(dept.id)),
    count(queries.departmentStaff(dept.id, "doctor")),
    count(queries.departmentStaff(dept.id, "nurse")),
    count(queries.departmentAdmitted(dept.id)),
    count(queries.departmentAppointments(dept.id, today, addMs(today, DAY))),
  ]);
  const occupancyRate = dept.bedCapacity > 0 ? Math.round((admittedPatients / dept.bedCapacity) * 1000) / 1000 : null;
  return { staff, doctors, nurses, admittedPatients, occupancyRate, appointmentsToday };
}

async function checkUniqueName(facilityId, name, exceptId) {
  const same = await fetchAll(queries.departmentByName(facilityId, nameLower(name)), { limit: 2 });
  if (same.some((d) => d.id !== exceptId)) throw conflict("A department with this name already exists in the facility");
}

// The head must be an active doctor or nurse of the same facility; returns the name snapshot.
async function headName(facilityId, headId) {
  if (!headId) return null;
  const head = await getDoc("users", headId);
  if (!["doctor", "nurse"].includes(head?.role) || head.status !== "active" || head.facilityId !== facilityId) {
    throw badRequest("headId must be an active doctor or nurse in the same facility");
  }
  return head.name;
}

export function register(router) {
  defineRoute(router, {
    method: "get",
    path: "/facilities",
    permission: "facility:read",
    summary: "List facilities, sorted by name",
    description: "Active facilities only, except for admins (?status=). Facility management is deferred.",
    tags: ["Organisation"],
    request: { query: FacilityListQuery },
    responses: { 200: FacilityPage },
    async handler(req, res) {
      const { limit, cursor, ...filters } = req.valid.query;
      const page = await paginate(scoped.facilities(req.user, filters), { limit, cursor });
      res.json({ data: page.docs.map((d) => redact(req.user, "facility", serialize(d))), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/departments",
    permission: "department:read",
    summary: "List departments of the caller's facility, sorted by name",
    description: "System admins see every facility (or ?facilityId=). include=stats is for admins only.",
    tags: ["Organisation"],
    request: { query: DepartmentListQuery },
    responses: { 200: DepartmentPage },
    async handler(req, res) {
      const { limit, cursor, include, ...filters } = req.valid.query;
      if (include === "stats" && req.user.role !== "admin") throw forbidden("Department statistics are for administrators");
      const page = await paginate(scoped.departments(req.user, filters), { limit, cursor });
      const data = await Promise.all(
        page.docs.map(async (d) => {
          const dept = redact(req.user, "department", serialize(d));
          return include === "stats" ? { ...dept, stats: await departmentStats(raw(d)) } : dept;
        }),
      );
      res.json({ data, nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/departments",
    permission: "department:manage",
    summary: "Create a department",
    description: "Facility admins create in their own facility; system admins pass facilityId. Names are unique per facility.",
    tags: ["Organisation"],
    request: { body: DepartmentCreateRequest },
    responses: { 201: Department },
    problems: ["409"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const facilityId = systemAdmin(user) ? body.facilityId : user.facilityId;
      if (!systemAdmin(user) && body.facilityId && body.facilityId !== user.facilityId) throw forbidden();
      if (!facilityId) throw badRequest("facilityId is required");
      const facility = await getDoc("facilities", facilityId);
      if (!facility || facility.status !== "active") throw badRequest("facilityId must be an active facility");
      await checkUniqueName(facilityId, body.name);
      const ref = departments.doc();
      const batch = db.batch();
      batch.create(ref, {
        facilityId,
        name: body.name,
        nameLower: nameLower(body.name),
        headId: orNull(body.headId),
        headName: await headName(facilityId, body.headId),
        location: orNull(body.location),
        phone: orNull(body.phone),
        bedCapacity: body.bedCapacity,
        status: "active",
        ...createdFields(user),
      });
      writeAudit(batch, user, { action: "create", resource: { type: "department", id: ref.id }, changedFields: Object.keys(body) });
      await batch.commit();
      sendCreated(res, `/departments/${ref.id}`, redact(user, "department", serialize(await ref.get())));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/departments/{id}",
    permission: "department:manage",
    summary: "Edit or archive a department",
    tags: ["Organisation"],
    request: { params: idParam, body: DepartmentUpdateRequest },
    responses: { 200: Department },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const dept = authorize(user, "department:manage", await getDoc("departments", req.valid.params.id));
      const update = { ...body, ...updatedFields(user) };
      if (body.name) {
        await checkUniqueName(dept.facilityId, body.name, dept.id);
        update.nameLower = nameLower(body.name);
      }
      if (body.headId !== undefined) update.headName = await headName(dept.facilityId, body.headId);
      const ref = departments.doc(dept.id);
      const batch = db.batch();
      batch.update(ref, update);
      writeAudit(batch, user, {
        action: body.status ? "status-change" : "update",
        resource: { type: "department", id: dept.id },
        changedFields: Object.keys(body),
      });
      await batch.commit();
      res.json(redact(user, "department", serialize(await ref.get())));
    },
  });
}
