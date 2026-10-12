// Query specs: a plain description of a Firestore query that both the executor (lib/firestore-query.js)
// and the index coverage test (test/indexes.test.js) read, so a query cannot ship without its index.
//
//   { collection, path, where: [[field, op, value]], or?: [[...filters], ...],
//     orderBy: [[field, "asc" | "desc", "string" | "timestamp" | "number"]], filter?: (doc) => boolean }
//
// `collection` is the collection ID used by firestore.indexes.json; `path` is the full collection path
// (they differ for subcollections). `or` branches are each ANDed with `where`. `filter` runs in memory
// on the fetched page (used only where the remaining rows are a small subset).

const EQUALITY = new Set(["==", "in"]);
const RANGE = new Set(["<", "<=", ">", ">="]);

// Equality on one value, `in` on several (Firestore allows at most 30 disjunctions overall).
export function eq(field, value) {
  if (Array.isArray(value)) return value.length === 1 ? [field, "==", value[0]] : [field, "in", value];
  return [field, "==", value];
}

// Case-insensitive name prefix match on the lowercase copy (§1.5).
export const prefix = (field, q) => [
  [field, ">=", q],
  [field, "<", `${q}\uf8ff`],
];

export function spec(collection, { path = collection, where = [], or, orderBy = [], filter } = {}) {
  return { collection, path, where: where.filter(Boolean), or, orderBy, filter };
}

// The index-relevant shape of every query the spec issues: one per `or` branch.
export function queryShapes(s) {
  const branches = s.or?.length ? s.or.map((b) => [...s.where, ...b]) : [s.where];
  return branches.map((filters) => {
    const equality = [];
    let arrayContains = null;
    const range = new Set();
    for (const [field, op] of filters) {
      if (EQUALITY.has(op)) equality.push(field);
      else if (op === "array-contains") arrayContains = field;
      else if (RANGE.has(op)) range.add(field);
      else throw new Error(`Unsupported operator ${op}`);
    }
    return {
      collection: s.collection,
      equality: [...new Set(equality)].sort(),
      arrayContains,
      range: [...range],
      orderBy: s.orderBy.map(([field, dir = "asc"]) => [field, dir]),
    };
  });
}

const sameFields = (a, b) => a.length === b.length && a.every((f) => b.includes(f));

// Whether firestore.indexes.json (plus Firestore's automatic single-field indexes) serves a shape:
// an exact composite, or one (field, ...orderBy) composite per equality field (index merging, used
// only for queries without an inequality).
export function indexServes(shape, indexes) {
  let orderBy = shape.orderBy;
  if (shape.range.length > 1) return false;
  if (shape.range.length && !orderBy.length) orderBy = [[shape.range[0], "asc"]];
  if (shape.range.length && orderBy[0][0] !== shape.range[0]) return false; // inequality must sort first

  const filterFields = [...shape.equality, ...(shape.arrayContains ? [shape.arrayContains] : [])];
  if (!filterFields.length) return orderBy.length <= 1; // single-field index
  if (!orderBy.length) return true; // equality-only queries merge single-field indexes

  const candidates = indexes.filter((ix) => ix.collectionGroup === shape.collection && ix.queryScope === "COLLECTION");
  const fieldsOf = (ix) => ix.fields.filter((f) => f.fieldPath !== "__name__");
  const matchesSuffix = (fields, offset) =>
    fields.length === offset + orderBy.length &&
    orderBy.every(([f, dir], i) => {
      const ixf = fields[offset + i];
      return ixf.fieldPath === f && ixf.order === (dir === "desc" ? "DESCENDING" : "ASCENDING");
    });
  const prefixOk = (prefixFields) =>
    prefixFields.every((ixf) =>
      ixf.fieldPath === shape.arrayContains ? ixf.arrayConfig === "CONTAINS" : Boolean(ixf.order),
    );

  const exact = candidates.some((ix) => {
    const fields = fieldsOf(ix);
    const head = fields.slice(0, filterFields.length);
    return (
      sameFields(
        head.map((f) => f.fieldPath),
        filterFields,
      ) &&
      prefixOk(head) &&
      matchesSuffix(fields, filterFields.length)
    );
  });
  if (exact) return true;

  // Index merging is only relied on without an inequality; range queries need an exact composite.
  if (shape.range.length) return false;
  return filterFields.every((field) =>
    candidates.some((ix) => {
      const fields = fieldsOf(ix);
      return fields[0]?.fieldPath === field && prefixOk([fields[0]]) && matchesSuffix(fields, 1);
    }),
  );
}
