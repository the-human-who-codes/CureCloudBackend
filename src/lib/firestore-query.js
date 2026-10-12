// Executes query specs (authz/query.js) with cursor pagination (docs/domain-model.md §1.8).
import { FieldPath, Filter, Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { problem } from "./problem.js";

const toFilter = ([field, op, value]) => Filter.where(field, op, value);
const and = (filters) => (filters.length === 1 ? toFilter(filters[0]) : Filter.and(...filters.map(toFilter)));

export function toQuery(s) {
  let query = db.collection(s.path);
  if (s.or?.length) {
    const or = Filter.or(...s.or.map(and));
    query = query.where(s.where.length ? Filter.and(...s.where.map(toFilter), or) : or);
  } else {
    for (const [field, op, value] of s.where) query = query.where(field, op, value);
  }
  for (const [field, dir] of s.orderBy) query = query.orderBy(field, dir);
  return query;
}

// --- Cursors: base64url(JSON [...orderByValues, docId]) ------------------------------------------

function encodeCursor(s, snap) {
  const values = s.orderBy.map(([field]) => {
    const v = snap.get(field);
    return v instanceof Timestamp ? v.toDate().toISOString() : v;
  });
  return Buffer.from(JSON.stringify([...values, snap.id])).toString("base64url");
}

function decodeCursor(s, cursor) {
  let values;
  try {
    values = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw problem("invalid-cursor", "The cursor could not be decoded");
  }
  const invalid = () => problem("invalid-cursor", "The cursor does not match this list");
  if (!Array.isArray(values) || values.length !== s.orderBy.length + 1) throw invalid();
  const id = values[values.length - 1];
  if (typeof id !== "string" || !id) throw invalid();
  const typed = s.orderBy.map(([, , type = "string"], i) => {
    const v = values[i];
    if (type === "timestamp") {
      const d = typeof v === "string" ? new Date(v) : null;
      if (!d || Number.isNaN(d.getTime())) throw invalid();
      return Timestamp.fromDate(d);
    }
    if (typeof v !== type) throw invalid();
    return v;
  });
  return [...typed, id];
}

// One page: { docs, nextCursor }. Fetches limit + 1 to know whether there is another page.
export async function paginate(s, { limit = 25, cursor } = {}) {
  const lastDir = s.orderBy.at(-1)?.[1] ?? "asc";
  let query = toQuery(s).orderBy(FieldPath.documentId(), lastDir);
  if (cursor) query = query.startAfter(...decodeCursor(s, cursor));
  const snap = await query.limit(limit + 1).get();
  const docs = snap.docs.slice(0, limit);
  const nextCursor = snap.docs.length > limit ? encodeCursor(s, docs.at(-1)) : null;
  const visible = s.filter ? docs.filter((d) => s.filter({ id: d.id, ...d.data() })) : docs;
  return { docs: visible, nextCursor };
}

export async function count(s) {
  const snap = await toQuery(s).count().get();
  return snap.data().count;
}

// Bounded fetch for internal use (schedules, reports, checks). Applies the in-memory filter.
export async function fetchAll(s, { limit = 500, select } = {}) {
  let query = toQuery(s);
  if (select) query = query.select(...select);
  const snap = await query.limit(limit).get();
  return s.filter ? snap.docs.filter((d) => s.filter({ id: d.id, ...d.data() })) : snap.docs;
}

// Same as fetchAll inside a transaction (reads must come before writes).
export async function fetchInTx(tx, s, { limit = 500 } = {}) {
  const snap = await tx.get(toQuery(s).limit(limit));
  return s.filter ? snap.docs.filter((d) => s.filter({ id: d.id, ...d.data() })) : snap.docs;
}
