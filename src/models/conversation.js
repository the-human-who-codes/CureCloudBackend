// Conversation and Message (§2.14). REST only in v1; clients poll.
import { ROLES, auditFields, id, isoTimestamp, listQuery, opt, page, storedMeta, storedTimestamp, text } from "./common.js";
import { z } from "./zod.js";

export const CONVERSATION_TYPES = ["direct", "group", "channel", "patient"];
export const CONVERSATION_STATUSES = ["active", "archived"];

const lastMessageShape = (ts) => ({
  text: z.string().max(140),
  senderId: z.string(),
  senderName: z.string(),
  sentAt: ts,
});

const shape = (ts) => ({
  type: z.enum(CONVERSATION_TYPES),
  title: opt(text(100)),
  facilityId: z.string(),
  departmentId: opt(z.string()),
  patientId: opt(z.string()),
  participantIds: z.array(z.string()).max(50),
  participants: z.record(z.object({ name: z.string(), role: z.enum(ROLES) })),
  lastMessage: opt(z.object(lastMessageShape(ts))),
  lastMessageAt: ts,
  status: z.enum(CONVERSATION_STATUSES),
  ...auditFields(ts),
});

export const ConversationStored = z.object({
  ...shape(storedTimestamp),
  ...storedMeta,
  lastReadAt: z.record(storedTimestamp),
});
export const Conversation = z
  .object({ id, ...shape(isoTimestamp), unreadCount: z.number().int() })
  .openapi("Conversation");
export const ConversationPage = page(Conversation, "ConversationPage");

export const ConversationListQuery = listQuery.extend({ type: z.enum(CONVERSATION_TYPES).optional() }).strict();

export const ConversationCreateRequest = z
  .object({
    type: z.enum(CONVERSATION_TYPES),
    participantIds: z.array(id).max(50).optional(),
    title: text(100).optional(),
    patientId: id.optional(),
    departmentId: id.optional(),
  })
  .strict()
  .openapi("ConversationCreateRequest");

export const ConversationUpdateRequest = z
  .object({ title: text(100), status: z.enum(CONVERSATION_STATUSES) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("ConversationUpdateRequest");

const messageShape = (ts) => ({
  senderId: z.string(),
  senderName: z.string(),
  senderRole: z.enum(ROLES),
  text: text(4000),
  createdAt: ts,
});

export const MessageStored = z.object({ ...messageShape(storedTimestamp), schemaVersion: z.literal(2) });
export const Message = z.object({ id, ...messageShape(isoTimestamp) }).openapi("Message");
export const MessagePage = page(Message, "MessagePage");
export const MessageCreateRequest = z.object({ text: text(4000) }).strict().openapi("MessageCreateRequest");
export const MessageListQuery = listQuery.strict();
