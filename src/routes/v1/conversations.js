// Conversations and messages (docs/domain-model.md §2.14, §4.2 "Conversations"). REST only in v1.
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../../firebase.js";
import {
  authorize,
  can,
  getDoc,
  hasPermission,
  loadPatient,
  patientAccess,
  queries,
  redact,
  scoped,
  systemAdmin,
} from "../../authz/index.js";
import { count, paginate } from "../../lib/firestore-query.js";
import { badRequest, forbidden, invalidTransition } from "../../lib/problem.js";
import { defineRoute } from "../../lib/route.js";
import { raw, serialize, toJson } from "../../lib/serialize.js";
import { createdFields, sendCreated, updatedFields } from "../../lib/write.js";
import {
  Conversation,
  ConversationCreateRequest,
  ConversationListQuery,
  ConversationPage,
  ConversationUpdateRequest,
  Message,
  MessageCreateRequest,
  MessageListQuery,
  MessagePage,
  idParam,
} from "../../models/index.js";

const conversations = db.collection("conversations");
const STAFF_ROLES = ["doctor", "nurse", "admin"];

async function unreadCount(user, conversation) {
  const since = conversation.lastReadAt?.[user.id];
  return count(queries.unreadMessages(conversation.id, since));
}

async function conversationResponse(user, conversation) {
  return redact(user, "conversation", toJson(conversation), { unreadCount: await unreadCount(user, conversation) });
}

async function loadConversation(user, id, permission = "conversation:read") {
  const conversation = await getDoc("conversations", id);
  const patient = conversation?.type === "patient" ? await getDoc("patients", conversation.patientId) : null;
  authorize(user, permission, conversation, { patient }, { what: "conversation" });
  return conversation;
}

async function loadUsers(ids) {
  const snaps = await db.getAll(...ids.map((uid) => db.collection("users").doc(uid)));
  return snaps.map(raw);
}

// Validates participants per type (§2.14). Any participant that breaks the rules returns 403.
async function planConversation(user, body) {
  const ids = [...new Set([user.id, ...(body.participantIds ?? [])])];
  const base = { title: body.title ?? null, departmentId: null, patientId: null };

  if (body.type === "channel") {
    if (!hasPermission(user, "channel:manage")) throw forbidden("Only administrators can create channels");
    if (!body.title) throw badRequest("title is required for channels");
    if (body.participantIds?.length) throw badRequest("Channels have implicit membership; omit participantIds");
    // Facility admins create channels in their own facility; system admins name the facility.
    if (body.facilityId && !systemAdmin(user) && body.facilityId !== user.facilityId) {
      throw forbidden("You can only create channels in your own facility");
    }
    const facilityId = systemAdmin(user) ? body.facilityId : user.facilityId;
    if (!facilityId) throw badRequest("facilityId is required");
    const facility = await getDoc("facilities", facilityId);
    if (!facility || facility.status !== "active") throw badRequest("facilityId must be an active facility");
    if (body.departmentId) {
      const dept = await getDoc("departments", body.departmentId);
      if (!dept || dept.facilityId !== facilityId) throw badRequest("departmentId must be a department of the channel's facility");
    }
    return { ...base, type: "channel", facilityId, departmentId: body.departmentId ?? null, participantIds: [] };
  }
  if (body.departmentId) throw badRequest("departmentId is only for channels");
  if (body.facilityId) throw badRequest("facilityId is only for channels");

  if (body.type === "patient") {
    if (!body.patientId) throw badRequest("patientId is required for patient conversations");
    const patient = await loadPatient(user, body.patientId);
    if (!["self", "clinical"].includes(patientAccess(user, patient))) {
      throw forbidden("Only the patient or their care team can start this conversation");
    }
    if (!patient.userId) throw badRequest("This patient has no account to message");
    const people = await loadUsers(ids);
    const others = people.filter((p) => p?.id !== patient.userId);
    if (!ids.includes(patient.userId)) throw forbidden("The patient must be a participant");
    if (!others.length) throw forbidden("At least one care team member is required");
    const valid = others.every(
      (p) => p && ["doctor", "nurse"].includes(p.role) && p.status === "active" && patient.careTeam.includes(p.id),
    );
    if (!valid) throw forbidden("Every other participant must be an active member of the patient's care team");
    const facilityId = patient.facilityId ?? others.find((p) => p.facilityId)?.facilityId;
    if (!facilityId) throw badRequest("The patient's care team has no facility");
    return { ...base, type: "patient", facilityId, patientId: patient.id, participantIds: ids, people };
  }

  // direct and group: active staff of one facility. A system admin (no facility) may start either
  // with the staff of any one facility, which then becomes the conversation's facilityId.
  if (user.role === "patient") throw forbidden("Patients can only message their care team");
  if (body.patientId) throw badRequest("patientId is only for patient conversations");
  if (!user.facilityId && !systemAdmin(user)) throw forbidden("You are not assigned to a facility");
  if (body.type === "direct" && ids.length !== 2) throw badRequest("A direct conversation has exactly two participants");
  if (body.type === "group") {
    if (ids.length < 3) throw badRequest("A group needs at least three participants");
    if (!body.title) throw badRequest("title is required for groups");
  }
  const people = await loadUsers(ids);
  if (!people.every((p) => p && STAFF_ROLES.includes(p.role) && p.status === "active")) {
    throw forbidden("Participants must be active staff");
  }
  const facilityId = user.facilityId ?? people.find((p) => p.facilityId)?.facilityId ?? null;
  // Every facility member shares the facility; null-facility members are only system admins, and
  // only a system admin creator may include other system admins (direct between two of them).
  const sameFacility = people.every((p) => p.facilityId === facilityId || (systemAdmin(user) && systemAdmin(p)));
  if (!sameFacility || (facilityId === null && body.type === "group")) {
    throw forbidden("Participants must be active staff of one facility");
  }
  return { ...base, type: body.type, facilityId, participantIds: ids, people };
}

export function register(router) {
  defineRoute(router, {
    method: "get",
    path: "/conversations",
    permission: "conversation:read",
    summary: "The caller's conversations plus their facility's channels, by last message",
    description: "Each item carries the caller's unreadCount.",
    tags: ["Conversations"],
    request: { query: ConversationListQuery },
    responses: { 200: ConversationPage },
    async handler(req, res) {
      const user = req.user;
      const { limit, cursor, ...filters } = req.valid.query;
      const page = await paginate(scoped.conversations(user, filters), { limit, cursor });
      const visible = [];
      for (const d of page.docs) {
        const c = raw(d);
        // Staff in a patient conversation must still have clinical access to the patient.
        const patient = c.type === "patient" && user.role !== "patient" ? await getDoc("patients", c.patientId) : null;
        if (c.type !== "patient" || user.role === "patient" || can(user, "conversation:read", c, { patient })) visible.push(c);
      }
      res.json({ data: await Promise.all(visible.map((c) => conversationResponse(user, c))), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/conversations",
    permission: "conversation:create",
    summary: "Start a conversation or create a channel",
    description:
      "direct: two active staff of one facility, or a system admin and any active staff member (returns the existing one with 200). group: 3–50 active staff of one facility. channel: admins (channel:manage) of the facility; system admins pass facilityId; departmentId must be in that facility. patient: exactly the patient's account plus active care team doctors and nurses, otherwise 403.",
    tags: ["Conversations"],
    request: { body: ConversationCreateRequest },
    responses: { 200: Conversation, 201: Conversation },
    problems: ["404"],
    async handler(req, res) {
      const user = req.user;
      const { people = [], ...plan } = await planConversation(user, req.valid.body);
      const ref = plan.type === "direct" ? conversations.doc(`direct_${[...plan.participantIds].sort().join("_")}`) : conversations.doc();
      const participants = Object.fromEntries(people.map((p) => [p.id, { name: p.name, role: p.role }]));
      const now = Timestamp.now();
      const created = await db.runTransaction(async (tx) => {
        if (plan.type === "direct" && (await tx.get(ref)).exists) return false;
        tx.create(ref, {
          ...plan,
          participants,
          lastMessage: null,
          lastMessageAt: now,
          lastReadAt: {},
          status: "active",
          ...createdFields(user),
        });
        return true;
      });
      const body = await conversationResponse(user, raw(await ref.get()));
      if (created) sendCreated(res, `/conversations/${ref.id}`, body);
      else res.json(body);
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/conversations/{id}",
    permission: "conversation:read",
    summary: "Get a conversation",
    tags: ["Conversations"],
    request: { params: idParam },
    responses: { 200: Conversation },
    problems: ["404"],
    async handler(req, res) {
      res.json(await conversationResponse(req.user, await loadConversation(req.user, req.valid.params.id)));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/conversations/{id}",
    permission: ["channel:manage", "conversation:read"],
    summary: "Rename or archive a channel (admins), or rename a group (participants)",
    description: "Channels need channel:manage; groups need the caller to be a participant (conversation:read). Participants cannot be changed in v1.",
    tags: ["Conversations"],
    request: { params: idParam, body: ConversationUpdateRequest },
    responses: { 200: Conversation },
    problems: ["404"],
    async handler(req, res) {
      const user = req.user;
      const body = req.valid.body;
      const conversation = await loadConversation(user, req.valid.params.id);
      if (conversation.type === "channel") authorize(user, "channel:manage", conversation);
      else if (conversation.type !== "group" || body.status !== undefined) {
        throw forbidden("Only group titles and channels can be changed");
      }
      const ref = conversations.doc(conversation.id);
      await ref.update({ ...body, ...updatedFields(user) });
      res.json(await conversationResponse(user, raw(await ref.get())));
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/conversations/{id}/messages",
    permission: "conversation:read",
    summary: "Messages, newest first",
    tags: ["Conversations"],
    request: { params: idParam, query: MessageListQuery },
    responses: { 200: MessagePage },
    problems: ["404"],
    async handler(req, res) {
      const conversation = await loadConversation(req.user, req.valid.params.id);
      const page = await paginate(scoped.messages(req.user, conversation.id), req.valid.query);
      res.json({ data: page.docs.map((d) => redact(req.user, "message", serialize(d))), nextCursor: page.nextCursor });
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/conversations/{id}/messages",
    permission: "message:create",
    summary: "Send a message",
    description: "Updates lastMessage, lastMessageAt and the sender's read marker.",
    tags: ["Conversations"],
    request: { params: idParam, body: MessageCreateRequest },
    responses: { 201: Message },
    problems: ["404", "409"],
    async handler(req, res) {
      const user = req.user;
      const conversation = await loadConversation(user, req.valid.params.id, "message:create");
      if (conversation.status === "archived") throw invalidTransition("The conversation is archived");
      const ref = conversations.doc(conversation.id);
      const messageRef = ref.collection("messages").doc();
      const now = Timestamp.now();
      const { text } = req.valid.body;
      const batch = db.batch();
      batch.create(messageRef, { senderId: user.id, senderName: user.name, senderRole: user.role, text, createdAt: now, schemaVersion: 2 });
      batch.update(ref, {
        lastMessage: { text: text.slice(0, 140), senderId: user.id, senderName: user.name, sentAt: now },
        lastMessageAt: now,
        [`lastReadAt.${user.id}`]: now,
        ...updatedFields(user),
      });
      await batch.commit();
      sendCreated(res, `/conversations/${conversation.id}/messages/${messageRef.id}`, redact(user, "message", serialize(await messageRef.get())));
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/conversations/{id}/read",
    permission: "conversation:read",
    summary: "Mark the conversation read for the caller",
    tags: ["Conversations"],
    request: { params: idParam },
    responses: { 204: { schema: undefined, description: "Marked read" } },
    problems: ["404"],
    async handler(req, res) {
      const conversation = await loadConversation(req.user, req.valid.params.id);
      await conversations.doc(conversation.id).update({ [`lastReadAt.${req.user.id}`]: Timestamp.now() });
      res.status(204).end();
    },
  });
}
