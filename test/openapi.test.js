// OpenAPI coverage (docs/domain-model.md §1.11, §8): the generated document is valid, documents every
// Express route under /api/v1 and nothing else, matches the committed docs/openapi.json, and is served
// together with Swagger UI without authentication.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { validate } from "@readme/openapi-parser";
import { app } from "../src/app.js";
import { routeTable } from "../src/lib/route.js";
import * as models from "../src/models/index.js";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi.js";
import { V1, api } from "./helpers.js";

const METHODS = ["get", "post", "put", "patch", "delete"];
const doc = buildOpenApiDocument();
const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((method) => ({ method, path, op: item[method] })),
);
const key = (method, path) => `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`;

// Express 5 keeps its routes in app.router.stack; the v1 router is the layer mounted at /api/v1.
function expressRoutes() {
  const v1 = app.router.stack.find((layer) => layer.handle?.stack && layer.matchers[0](`${V1}/x`)?.path === V1);
  assert.ok(v1, "the /api/v1 router is mounted");
  const top = app.router.stack.filter((layer) => layer.route).map((layer) => ({ prefix: "", route: layer.route }));
  const nested = v1.handle.stack.filter((layer) => layer.route).map((layer) => ({ prefix: V1, route: layer.route }));
  return [...top, ...nested].flatMap(({ prefix, route }) =>
    Object.keys(route.methods).map((method) => key(method, `${prefix}${route.path}`)),
  );
}

describe("OpenAPI document", () => {
  test("is a valid OpenAPI 3.1 document", async () => {
    assert.equal(doc.openapi, "3.1.0");
    const result = await validate(structuredClone(doc));
    assert.deepEqual(result.errors ?? [], []);
    assert.equal(result.valid, true);
  });

  test("documents every Express route and nothing else", () => {
    const documented = operations.map(({ method, path }) => key(method, path)).sort();
    // The documentation routes themselves are the only undocumented ones.
    const routes = expressRoutes().filter((r) => r !== "GET /api/openapi.json").sort();
    assert.deepEqual(documented, routes);
    assert.equal(new Set(documented).size, documented.length, "no duplicate operations");
    // defineRoute's own record agrees with Express.
    assert.deepEqual(
      routeTable.map((r) => key(r.method, `${V1}${r.path}`)).sort(),
      routes.filter((r) => r.includes(`${V1}/`)),
    );
  });

  test("every operation has a summary, tag, permission, security and error responses", () => {
    const tags = new Set(doc.tags.map((t) => t.name));
    for (const { method, path, op } of operations) {
      const where = `${method.toUpperCase()} ${path}`;
      assert.ok(op.summary, `${where}: summary`);
      assert.equal(op.tags?.length, 1, `${where}: one tag`);
      assert.ok(tags.has(op.tags[0]), `${where}: tag ${op.tags[0]} is declared`);
      assert.ok(op["x-permission"], `${where}: x-permission`);
      const isPublic = op["x-permission"] === "public";
      assert.deepEqual(op.security, isPublic ? [] : [{ bearerAuth: [] }], `${where}: security`);
      if (isPublic) {
        assert.match(op.description, /Public: no token required/, `${where}: public note`);
      } else {
        assert.ok(op.responses["401"], `${where}: 401`);
        if (op["x-permission"] !== "signed-in") {
          for (const p of op["x-permission"].split(" | ")) {
            assert.ok(op.description.includes(`\`${p}\``), `${where}: description names ${p}`);
          }
          assert.ok(op.responses["403"], `${where}: 403`);
        }
      }
      if (path.startsWith(V1)) assert.ok(op.responses["500"], `${where}: 500`);
      if (op.parameters?.length || op.requestBody) assert.ok(op.responses["400"], `${where}: 400`);
      for (const [status, response] of Object.entries(op.responses)) {
        if (Number(status) >= 400) {
          assert.match(response.$ref, /^#\/components\/responses\//, `${where} ${status}: problem response`);
        }
        if (status === "201") assert.ok(response.headers?.Location, `${where}: 201 has a Location header`);
      }
      for (const name of path.match(/\{(\w+)\}/g) ?? []) {
        const param = name.slice(1, -1);
        assert.ok(
          op.parameters?.some((p) => p.in === "path" && p.name === param && p.required),
          `${where}: path parameter ${param}`,
        );
      }
    }
  });

  test("error responses are problem+json and list pages describe pagination", () => {
    for (const [name, response] of Object.entries(doc.components.responses)) {
      assert.deepEqual(
        response.content["application/problem+json"].schema,
        { $ref: "#/components/schemas/Problem" },
        `${name}: problem+json`,
      );
    }
    const lists = operations.filter(({ op }) => {
      const ref = op.responses["200"]?.content?.["application/json"]?.schema?.$ref;
      return ref && doc.components.schemas[ref.split("/").pop()].properties?.nextCursor;
    });
    assert.ok(lists.length > 10, "list endpoints found");
    for (const { method, path, op } of lists) {
      const names = op.parameters.filter((p) => p.in === "query").map((p) => p.name);
      assert.ok(names.includes("limit") && names.includes("cursor"), `${method} ${path}: limit and cursor`);
      assert.match(op.description, /Paginated/, `${method} ${path}: pagination note`);
    }
  });

  test("every named model is a component schema", () => {
    const names = Object.values(models)
      .map((schema) => schema?._def?.openapi?._internal?.refId)
      .filter(Boolean);
    assert.ok(names.length > 50);
    for (const name of names) assert.ok(doc.components.schemas[name], `components.schemas.${name}`);
  });

  test("docs/openapi.json is up to date (npm run openapi)", () => {
    const committed = readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8");
    assert.equal(committed, serializeOpenApiDocument(doc), "run `npm run openapi` and commit docs/openapi.json");
  });
});

describe("OpenAPI routes", () => {
  test("GET /api/openapi.json is public and cacheable", async () => {
    const res = await api().get("/api/openapi.json").expect(200).expect("content-type", /json/);
    assert.deepEqual(res.body, JSON.parse(JSON.stringify(doc)));
    assert.match(res.headers["cache-control"], /^public, max-age=\d+$/);
  });

  test("GET /api/docs serves Swagger UI with relative asset URLs", async () => {
    for (const [path, assets] of [
      ["/api/docs", "docs/assets/"],
      ["/api/docs/", "assets/"],
    ]) {
      const res = await api().get(path).expect(200).expect("content-type", /html/);
      assert.match(res.text, new RegExp(`src="${assets}swagger-ui-bundle\\.js"`));
      assert.match(res.headers["cache-control"], /^public/);
    }
    await api().get("/api/docs/assets/swagger-ui-bundle.js").expect(200).expect("content-type", /javascript/);
    await api().get("/api/docs/assets/swagger-ui.css").expect(200).expect("content-type", /css/);
    const init = await api().get("/api/docs/assets/init.js").expect(200);
    assert.match(init.text, /\.\.\/\.\.\/openapi\.json/);
    // Only the allowlisted Swagger UI files are served.
    await api().get("/api/docs/assets/index.html").expect(404).expect("content-type", /problem\+json/);
    await api().get("/api/docs/assets/..%2Fpackage.json").expect(404);
  });

  test("data routes stay no-store", async () => {
    const res = await api().get("/api/health").expect(200);
    assert.equal(res.headers["cache-control"], "no-store");
    const v1 = await api().get(`${V1}/me`).expect(401);
    assert.equal(v1.headers["cache-control"], "no-store");
  });
});
