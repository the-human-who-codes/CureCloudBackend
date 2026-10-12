// defineRoute (docs/domain-model.md §1.11): mounts an Express handler with authentication, the
// permission check and zod validation, and registers the same operation in the OpenAPI registry.
// Express 5 does not expose its route table, so every call is also recorded in `routeTable`.
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { requirePermission } from "../authz/index.js";
import { authenticate } from "../middleware/auth.js";
import { HIDDEN_FIELDS } from "../models/common.js";
import { Problem } from "../models/problem.js";
import { validationProblem } from "./problem.js";

export const registry = new OpenAPIRegistry();
export const routeTable = [];

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description: "Firebase ID token",
});

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

  const problemResponses = Object.fromEntries(
    [...new Set([...(request.body || request.query || request.params ? ["400"] : []), ...(isPublic ? [] : ["401", "403"]), ...problems])].map(
      (status) => [status, { description: "Problem details (RFC 9457)", content: { "application/problem+json": { schema: Problem } } }],
    ),
  );

  registry.registerPath({
    method,
    path: `/api/v1${path}`,
    summary,
    description,
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
            description: r.description ?? (status === "204" ? "No content" : "OK"),
            ...(r.schema && { content: { "application/json": { schema: r.schema } } }),
          },
        ]),
      ),
      ...problemResponses,
    },
  });
}
