// defineRoute (docs/domain-model.md §1.11): mounts an Express handler with authentication, the
// permission check and zod validation, and registers the same operation in the OpenAPI registry.
// Express 5 does not expose its route table, so every call is also recorded in `routeTable`.
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { requirePermission } from "../authz/index.js";
import { authenticate } from "../middleware/auth.js";
import { HIDDEN_FIELDS } from "../models/common.js";
import { PROBLEM_BASE, PROBLEMS, Problem } from "../models/problem.js";
import { validationProblem } from "./problem.js";

export const registry = new OpenAPIRegistry();
export const routeTable = [];

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description: "Firebase ID token from the signed-in client (`await auth.currentUser.getIdToken()`).",
});

// One reusable problem+json response per error status. The descriptions list the problem codes from
// models/problem.js, so a new code shows up in the docs without touching this file.
registry.register("Problem", Problem);
const PROBLEM_RESPONSES = {
  400: ["BadRequest", "The request failed validation; `errors` lists each invalid field."],
  401: ["Unauthenticated", "The bearer token is missing, invalid or expired."],
  403: ["Forbidden", "The caller lacks the permission, or the action or a field is forbidden for this resource."],
  404: ["NotFound", "The resource does not exist or the caller has no relationship to it."],
  409: ["Conflict", "The request conflicts with the resource's current state."],
  500: ["InternalError", "Unexpected server error. The response never contains request data."],
};
for (const [status, [name, description]] of Object.entries(PROBLEM_RESPONSES)) {
  const codes = Object.entries(PROBLEMS).filter(([, p]) => String(p.status) === status);
  const [code, { title }] = codes[0];
  registry.registerComponent("responses", name, {
    description: `${description} Problem codes: ${codes.map(([c]) => `\`${c}\``).join(", ")}.`,
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/Problem" },
        example: { type: `${PROBLEM_BASE}${code}`, title, status: Number(status), code },
      },
    },
  });
}
const problemRef = (status) => ({ $ref: `#/components/responses/${PROBLEM_RESPONSES[status][0]}` });

const LOCATION_HEADER = {
  Location: { description: "Path of the created resource", schema: { type: "string", example: "/api/v1/appointments/Zr3kq0Yh6x2bWm1PpL9c" } },
};

const PAGINATION_NOTE =
  "Paginated: `limit` (1-100, default 25) sets the page size; pass the previous page's `nextCursor` as " +
  "`cursor` for the next page. `nextCursor` is null on the last page.";

const isPage = (schema) => schema?.shape?.data !== undefined && schema?.shape?.nextCursor !== undefined;

function permissionNote(permission) {
  if (permission === "public") return "Public: no token required.";
  if (permission === "signed-in") return "Requires a valid ID token; any account status, with or without a profile.";
  return `Requires permission ${[permission].flat().map((p) => `\`${p}\``).join(" or ")}.`;
}

// "public": no token. "signed-in": a valid token, any account status (GET/POST /me).
const SPECIAL = new Set(["public", "signed-in"]);

const toExpressPath = (path) => path.replace(/\{(\w+)\}/g, ":$1");

function parse(schema, data, where) {
  if (!schema) return data;
  const result = schema.safeParse(data ?? {});
  if (!result.success) throw validationProblem(result.error, where === "body" ? undefined : where);
  return result.data;
}

function findHidden(value, path = "") {
  if (Array.isArray(value)) return value.map((v, i) => findHidden(v, `${path}[${i}]`)).find(Boolean);
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (HIDDEN_FIELDS.includes(k)) return `${path}.${k}`;
      const nested = findHidden(v, `${path}.${k}`);
      if (nested) return nested;
    }
  }
  return null;
}

// In tests (VALIDATE_RESPONSES=1) every JSON response is checked against its declared schema and
// for hidden fields, so the schemas stay a faithful description of the API.
function validateResponses(method, path, responses) {
  return (_req, res, next) => {
    if (process.env.VALIDATE_RESPONSES !== "1") return next();
    const json = res.json.bind(res);
    res.json = (body) => {
      const schema = responses[res.statusCode]?.schema;
      if (!schema) throw new Error(`${method.toUpperCase()} ${path}: no response schema for ${res.statusCode}`);
      const result = schema.safeParse(body);
      if (!result.success) {
        const issues = result.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
        throw new Error(`${method.toUpperCase()} ${path} ${res.statusCode} does not match its schema: ${issues.join("; ")}`);
      }
      const hidden = findHidden(body);
      if (hidden) throw new Error(`${method.toUpperCase()} ${path} leaks hidden field ${hidden}`);
      return json(body);
    };
    next();
  };
}

const normalizeResponses = (responses) =>
  Object.fromEntries(
    Object.entries(responses).map(([status, r]) => [
      status,
      r && r.schema !== undefined ? r : { schema: r, description: r?.description },
    ]),
  );

/**
 * @param {import("express").Router} router
 * @param {{ method: "get"|"post"|"patch"|"delete", path: string, permission: string|string[],
 *   summary?: string, description?: string, tags?: string[], request?: { params?, query?, body? },
 *   responses: Record<number, import("zod").ZodTypeAny | { schema, description }>,
 *   problems?: string[], handler: Function }} def
 */
export function defineRoute(router, def) {
  const { method, path, permission, summary, description, tags = [], request = {}, problems = [], handler } = def;
  const responses = normalizeResponses(def.responses);
  const isPublic = permission === "public";

  const middleware = [];
  if (!isPublic) middleware.push(authenticate);
  if (!SPECIAL.has(permission)) middleware.push(requirePermission(permission));
  middleware.push((req, _res, next) => {
    req.valid = {
      params: parse(request.params, req.params, "params"),
      query: parse(request.query, req.query, "query"),
      body: parse(request.body, req.body, "body"),
    };
    next();
  });
  middleware.push(validateResponses(method, path, responses));

  router[method](toExpressPath(path), ...middleware, handler);
  routeTable.push({ method, path, permission });

  const problemStatuses = new Set([
    ...(request.body || request.query || request.params ? ["400"] : []),
    ...(isPublic ? [] : ["401"]),
    ...(SPECIAL.has(permission) ? [] : ["403"]),
    ...problems,
    "500",
  ]);
  const paginated = Object.values(responses).some((r) => isPage(r.schema));
  registry.registerPath({
    method,
    path: `/api/v1${path}`,
    summary,
    description: [description, paginated && PAGINATION_NOTE, permissionNote(permission)].filter(Boolean).join("\n\n"),
    tags,
    "x-permission": [permission].flat().join(" | "),
    security: isPublic ? [] : [{ bearerAuth: [] }],
    request: {
      ...(request.params && { params: request.params }),
      ...(request.query && { query: request.query }),
      ...(request.body && { body: { required: true, content: { "application/json": { schema: request.body } } } }),
    },
    responses: {
      ...Object.fromEntries(
        Object.entries(responses).map(([status, r]) => [
          status,
          {
            description: r.description ?? (status === "204" ? "No content" : status === "201" ? "Created" : "OK"),
            ...(status === "201" && { headers: LOCATION_HEADER }),
            ...(r.schema && { content: { "application/json": { schema: r.schema } } }),
          },
        ]),
      ),
      ...Object.fromEntries([...problemStatuses].sort().map((status) => [status, problemRef(status)])),
    },
  });
}
