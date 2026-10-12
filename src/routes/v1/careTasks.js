// Care tasks (docs/domain-model.md §2.10, §4.2 "Care tasks and shifts").
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebase.js";
import { authorize, can, clinical, getDoc, loadPatient, patientsById, redact, scoped } from "../../authz/index.js";
import { writeAudit } from "../../lib/audit.js";
import { paginate } from "../../lib/firestore-query.js";
import { notify } from "../../lib/notify.js";
import { badRequest, conflict, forbidden, invalidTransition, notFound } from "../../lib/problem.js";
import { defineRoute } from "../../lib/route.js";
import { raw, serialize, toJson } from "../../lib/serialize.js";
import { createdFields, orNull, sendCreated, updatedFields } from "../../lib/write.js";
import {
  CareTask,
  CareTaskCreateRequest,
  CareTaskListQuery,
  CareTaskPage,
  CareTaskUpdateRequest,
  TASK_TRANSITIONS,
  idParam,
} from "../../models/index.js";

const tasks = db.collection("careTasks");

// Patient tasks: the assignee must be a doctor or nurse with clinical access to the patient (403).
// Ward-level tasks: active staff of the task's department (400).
async function loadAssignee(assigneeId, { patient, departmentId }) {
  const staff = await getDoc("users", assigneeId);
  const active = ["doctor", "nurse"].includes(staff?.role) && staff.status === "active";
  if (patient) {
    if (!active || !clinical(staff, patient)) throw forbidden("The assignee needs clinical access to the patient");
  } else if (!active || staff.departmentId !== departmentId) {
    throw badRequest("assigneeId must be active staff of the task's department");
  }
  return staff;
}

// Ward-level tasks: an active department of the caller's facility; nurses only their own (§2.10).
async function loadWardDepartment(user, departmentId) {
  const dept = await getDoc("departments", departmentId);
  if (!dept || dept.status !== "active") throw badRequest("departmentId must be an active department");
  if (dept.facilityId !== user.facilityId) throw forbidden("The department is in another facility");
  if (user.role === "nurse" && dept.id !== user.departmentId) throw forbidden("Nurses create ward tasks in their own department");
  return dept;
}

async function loadTask(user, id, permission = "care-task:read") {
  const task = await getDoc("careTasks", id);
  const patient = task?.patientId ? await getDoc("patients", task.patientId) : null;
  authorize(user, permission, task, { patient }, { what: "care task" });
  return { task, patient };
}

export function register(router) {
  defineRoute(router, {
    method: "get",
    path: "/care-tasks",
    permission: "care-task:read",
    summary: "List care tasks, by dueAt (or completedAt desc with completedBy)",
    description:
      "assigneeId accepts me, unassigned and (nurses) a nurse of their own department; completedBy accepts only me; departmentId must be the caller's own. Doctors may use other actor values only with a clinical patientId. Default for nurses: own department, open and in-progress.",
    tags: ["Care tasks"],
    request: { query: CareTaskListQuery },
    responses: { 200: CareTaskPage },
    problems: ["404"],
    async handler(req, res) {
      const user = req.user;
      const { limit, cursor, patientId, dueBefore, completedAfter, ...filters } = req.valid.query;
      const ctx = {};
      if (patientId) {
        const patient = await loadPatient(user, patientId);
        if (!clinical(user, patient)) throw notFound("patient");
        ctx.patientId = patient.id;
      }
      const assignee = filters.assigneeId;
      if (assignee && !["me", "unassigned", user.id].includes(assignee) && user.role === "nurse" && !ctx.patientId) {
        const colleague = await getDoc("users", assignee);
        if (colleague?.role === "nurse" && colleague.departmentId && colleague.departmentId === user.departmentId) {
          ctx.assigneeId = colleague.id;
        }
      }
      const s = scoped.careTasks(
        user,
        {
          ...filters,
          patientId,
          dueBefore: dueBefore && new Date(dueBefore),
          completedAfter: completedAfter && new Date(completedAfter),
        },
        ctx,
      );
      const page = await paginate(s, { limit, cursor });
      // Patient tasks stay visible only while the caller has clinical access to the patient, so the
      // page is filtered in memory (it may hold fewer than limit items; nextCursor follows the query).
      const byId = await patientsById(page.docs.map((d) => d.get("patientId")));
      const visible = page.docs.filter((d) => can(user, "care-task:read", raw(d), { patient: byId.get(d.get("patientId")) }));
      res.json({ data: visible.map((d) => redact(user, "care-task", serialize(d))), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/care-tasks",
    permission: "care-task:create",
    summary: "Create a care task",
    description:
      "Patient tasks need clinical access; departmentId is not accepted (it is the patient's admission department, or null) and the assignee must have clinical access (403). Ward-level tasks need departmentId: an active department of the caller's facility (nurses: their own); the assignee must be active staff of it. Assigning notifies the assignee.",
    tags: ["Care tasks"],
    request: { body: CareTaskCreateRequest },
    responses: { 201: CareTask },
    problems: ["404"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const patient = body.patientId ? await loadPatient(user, body.patientId) : null;
      authorize(user, "care-task:create", {}, { patient });
      const dept = patient ? null : await loadWardDepartment(user, body.departmentId);
      const departmentId = patient ? (patient.admission?.departmentId ?? null) : dept.id;
      const facilityId = patient ? (patient.facilityId ?? user.facilityId) : dept.facilityId;
      const assignee = body.assigneeId ? await loadAssignee(body.assigneeId, { patient, departmentId }) : null;

      const ref = tasks.doc();
      const batch = db.batch();
      batch.create(ref, {
        patientId: patient?.id ?? null,
        patientName: patient?.name ?? null,
        facilityId,
        departmentId,
        title: body.title,
        description: orNull(body.description),
        category: body.category,
        priority: body.priority,
        dueAt: Timestamp.fromDate(new Date(body.dueAt)),
        status: "open",
        assigneeId: assignee?.id ?? null,
        assigneeName: assignee?.name ?? null,
        startedAt: null,
        completedAt: null,
        completedBy: null,
        completionNote: null,
        ...createdFields(user),
      });
      writeAudit(batch, user, {
        action: "create",
        resource: { type: "care-task", id: ref.id },
        patientId: patient?.id ?? null,
        changedFields: Object.keys(body),
      });
      if (assignee && assignee.id !== user.id) {
        notify(batch, assignee.id, {
          title: "Task assigned to you",
          description: body.title,
          type: "care-task",
          resource: { type: "care-task", id: ref.id },
        });
      }
      await batch.commit();
      sendCreated(res, `/care-tasks/${ref.id}`, redact(user, "care-task", serialize(await ref.get())));
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/care-tasks/{id}",
    permission: "care-task:read",
    summary: "Get a care task",
    tags: ["Care tasks"],
    request: { params: idParam },
    responses: { 200: CareTask },
    problems: ["404"],
    async handler(req, res) {
      const { task } = await loadTask(req.user, req.valid.params.id);
      res.json(redact(req.user, "care-task", toJson(task)));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/care-tasks/{id}",
    permission: "care-task:update",
    summary: "Claim, start, release, complete, cancel or edit a care task",
    description:
      "open → in-progress → completed, in-progress → open (release), open|in-progress → cancelled (the creator, or a doctor with clinical access). Completed and cancelled tasks are terminal.",
    tags: ["Care tasks"],
    request: { params: idParam, body: CareTaskUpdateRequest },
    responses: { 200: CareTask },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const { task, patient } = await loadTask(req.user, req.valid.params.id, "care-task:update");
      if (!TASK_TRANSITIONS[task.status]) throw conflict(`A ${task.status} task cannot be changed`, "record-immutable");

      const update = { ...updatedFields(user) };
      for (const key of ["title", "description", "priority", "completionNote"]) {
        if (body[key] !== undefined) update[key] = body[key];
      }
      if (body.dueAt) update.dueAt = Timestamp.fromDate(new Date(body.dueAt));

      let assignee = null;
      if (body.assigneeId !== undefined && body.assigneeId !== task.assigneeId) {
        if (body.assigneeId === null) Object.assign(update, { assigneeId: null, assigneeName: null });
        else {
          assignee = await loadAssignee(body.assigneeId, { patient, departmentId: task.departmentId });
          Object.assign(update, { assigneeId: assignee.id, assigneeName: assignee.name });
        }
      }

      if (body.status && body.status !== task.status) {
        if (!TASK_TRANSITIONS[task.status].includes(body.status)) {
          throw invalidTransition(`Cannot change from ${task.status} to ${body.status}`);
        }
        const now = Timestamp.now();
        if (body.status === "cancelled") {
          const mayCancel = task.createdBy === user.id || user.role === "doctor";
          if (!mayCancel) throw forbidden("Only the creator or a doctor can cancel a task");
        }
        if (body.status === "in-progress") {
          update.startedAt = now;
          if (!task.assigneeId && body.assigneeId === undefined && user.role === "nurse") {
            Object.assign(update, { assigneeId: user.id, assigneeName: user.name }); // starting claims it
          }
        }
        if (body.status === "open") update.startedAt = null;
        if (body.status === "completed") Object.assign(update, { completedAt: now, completedBy: user.id });
        update.status = body.status;
      } else if (body.completionNote !== undefined && !["completed", "cancelled"].includes(body.status)) {
        throw badRequest("completionNote is only set when completing or cancelling");
      }

      const ref = tasks.doc(task.id);
      const batch = db.batch();
      batch.update(ref, update);
      writeAudit(batch, user, {
        action: update.status ? "status-change" : "update",
        resource: { type: "care-task", id: task.id },
        patientId: task.patientId ?? null,
        changedFields: Object.keys(body),
      });
      if (assignee && assignee.id !== user.id) {
        notify(batch, assignee.id, {
          title: "Task assigned to you",
          description: update.title ?? task.title,
          type: "care-task",
          resource: { type: "care-task", id: task.id },
        });
      }
      await batch.commit();
      res.json(redact(user, "care-task", serialize(await ref.get())));
    },
  });
}
