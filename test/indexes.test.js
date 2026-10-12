// Every query shape the API can issue must be served by firestore.indexes.json. The emulator does not
// enforce composite indexes, so without this test a missing index would only fail in production.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { indexServes } from "../src/authz/query.js";
import { allShapes } from "./query-shapes.js";

const { indexes } = JSON.parse(readFileSync(new URL("../firestore.indexes.json", import.meta.url), "utf8"));

test("every query shape has an index", () => {
  const shapes = allShapes();
  assert.ok(shapes.length > 500, `expected the enumeration to cover many shapes, got ${shapes.length}`);
  const missing = shapes.filter((s) => !indexServes(s, indexes));
  assert.deepEqual(
    missing.map((s) => `${s.label}: ${s.collection} eq=[${s.equality}] contains=${s.arrayContains} range=[${s.range}] orderBy=${JSON.stringify(s.orderBy)}`),
    [],
  );
});

test("index file is well-formed", () => {
  const seen = new Set();
  for (const ix of indexes) {
    assert.equal(ix.queryScope, "COLLECTION");
    assert.ok(ix.fields.length >= 2, `${ix.collectionGroup}: composite indexes need two or more fields`);
    const key = JSON.stringify([ix.collectionGroup, ix.fields]);
    assert.ok(!seen.has(key), `duplicate index ${key}`);
    seen.add(key);
  }
  assert.ok(indexes.length <= 200, "Firestore allows at most 200 composite indexes");
});

test("the matcher rejects unserved shapes", () => {
  const shape = { collection: "careTasks", equality: ["title"], arrayContains: null, range: [], orderBy: [["dueAt", "asc"]] };
  assert.equal(indexServes(shape, indexes), false);
  const range = { collection: "appointments", equality: ["type"], arrayContains: null, range: ["start"], orderBy: [["start", "asc"]] };
  assert.equal(indexServes(range, indexes), false);
});
