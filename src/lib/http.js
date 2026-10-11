import { Timestamp } from "firebase-admin/firestore";

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const forbidden = (message = "You do not have access to this resource") =>
  new HttpError(403, message);
export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`);
export const conflict = (message) => new HttpError(409, message);

export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) throw badRequest("Invalid request", result.error.flatten());
  return result.data;
}

// Firestore Timestamps -> ISO strings, recursively, so responses are plain JSON.
function toJson(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  }
  return value;
}

export const serialize = (snap) => ({ id: snap.id, ...toJson(snap.data()) });

export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message, details: err.details });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Malformed JSON body" });
  }
  console.error(err);
  return res.status(500).json({ message: "Internal server error" });
}
