// OpenAPI 3.1 document and Swagger UI (docs/domain-model.md §1.11). The document is generated from the
// registry that defineRoute (lib/route.js) fills from the zod models, so it cannot drift from the code.
// Both routes are public: they describe the API and contain no data.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { Router } from "express";
import { notFound } from "./lib/problem.js";
import { registry } from "./lib/route.js";
import * as models from "./models/index.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const swaggerUiDir = createRequire(import.meta.url)("swagger-ui-dist").getAbsoluteFSPath();

// Register every named model, including those no route references yet, so the components section is
// the complete catalogue of src/models.
for (const schema of Object.values(models)) {
  const refId = schema?._def?.openapi?._internal?.refId;
  if (refId) registry.register(refId, schema);
}

// Unversioned uptime check, mounted directly in app.js.
registry.registerPath({
  method: "get",
  path: "/api/health",
  summary: "Health check",
  description: "Unversioned, for uptime checks.\n\nPublic: no token required.",
  tags: ["System"],
  "x-permission": "public",
  security: [],
  responses: { 200: { description: "OK", content: { "application/json": { schema: models.HealthResponse } } } },
});

const TAGS = [
  ["Me", "The caller's profile, preferences and staff sign-up"],
  ["Dashboard", "Role-specific dashboard and facility reports"],
  ["Users", "Accounts, approvals and the practitioner directory"],
  ["Organisation", "Facilities and departments"],
  ["Patients", "Patient records, care team, admissions and vitals"],
  ["Appointments", "Booking, rescheduling and availability"],
  ["Prescriptions", "Prescriptions, refills and medication administration"],
  ["Medical records", "Clinical notes, results and amendments"],
  ["Care tasks", "Ward and patient task lists"],
  ["Shifts", "Staff rosters, leave and handover"],
  ["Notifications", "Per-user notifications"],
  ["Conversations", "Care team and staff messaging"],
  ["System", "System settings, alerts and health"],
].map(([name, description]) => ({ name, description }));

const DESCRIPTION = `REST API for CureCloud, a health management system for South African public hospitals.

**Authentication.** Every endpoint except the public ones takes \`Authorization: Bearer <Firebase ID token>\`.
Each operation names the permission it requires (also in \`x-permission\`); \`GET /api/v1/me\` returns the
caller's permissions. A resource the caller has no relationship to returns 404; a visible resource with a
forbidden action or field returns 403.

**Conventions.** Lists take \`limit\` and \`cursor\` and return \`{ data, nextCursor }\`. Creates return 201 with
a \`Location\` header. Timestamps are ISO 8601 UTC; request instants carry an offset. Multi-value filters are
comma-separated. Errors are RFC 9457 \`application/problem+json\`.

The data model and authorization rules are described in \`docs/domain-model.md\` in the backend repository.`;

let cached;

export function buildOpenApiDocument() {
  cached ??= new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "CureCloud API", version, description: DESCRIPTION },
    servers: [
      // Relative to the document URL (…/api/openapi.json), so "Try it out" calls the deployment serving the docs.
      { url: "..", description: "This deployment" },
      { url: "https://africa-south1-curecloud1.cloudfunctions.net/api", description: "Production" },
    ],
    tags: TAGS,
  });
  return cached;
}

const ASSETS = new Set(["swagger-ui.css", "swagger-ui-bundle.js", "favicon-32x32.png"]);

// Asset URLs are relative so the page works behind the function URL prefix (/api/api/docs) and locally.
const page = (assets) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CureCloud API</title>
    <link rel="icon" type="image/png" href="${assets}favicon-32x32.png" />
    <link rel="stylesheet" href="${assets}swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${assets}swagger-ui-bundle.js"></script>
    <script src="${assets}init.js"></script>
  </body>
</html>
`;

// Resolved from the script's own URL (…/docs/assets/init.js), with or without a trailing slash on /docs.
const INIT = `window.ui = SwaggerUIBundle({
  url: new URL("../../openapi.json", document.currentScript.src).href,
  dom_id: "#swagger-ui",
  deepLinking: true,
  persistAuthorization: true,
});
`;

const cacheable = (res, seconds) => res.set("Cache-Control", `public, max-age=${seconds}`);

export function docsRouter() {
  const router = Router();
  router.get("/", (req, res) => {
    const trailingSlash = req.originalUrl.split("?")[0].endsWith("/");
    cacheable(res, 300).type("html").send(page(trailingSlash ? "assets/" : "docs/assets/"));
  });
  router.get("/assets/init.js", (_req, res) => cacheable(res, 300).type("js").send(INIT));
  router.get("/assets/:file", (req, res) => {
    if (!ASSETS.has(req.params.file)) throw notFound("asset");
    cacheable(res, 86400).sendFile(req.params.file, { root: swaggerUiDir });
  });
  return router;
}

export function serveOpenApiDocument(_req, res) {
  cacheable(res, 300).json(buildOpenApiDocument());
}

// The committed docs/openapi.json format (npm run openapi).
export const serializeOpenApiDocument = (doc) => `${JSON.stringify(doc, null, 2)}\n`;
