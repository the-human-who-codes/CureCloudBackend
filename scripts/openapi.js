// Writes the generated OpenAPI document to docs/openapi.json (npm run openapi). The test suite fails
// when the committed file is out of date, so re-run this after changing a route or model.
import { writeFileSync } from "node:fs";

// Loading the app initialises firebase-admin; point it at a demo project so nothing can reach a live one.
process.env.GCLOUD_PROJECT ??= "demo-curecloud";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";

await import("../src/app.js"); // registers every route
const { buildOpenApiDocument, serializeOpenApiDocument } = await import("../src/openapi.js");

const out = new URL("../docs/openapi.json", import.meta.url);
writeFileSync(out, serializeOpenApiDocument(buildOpenApiDocument()));
console.log(`Wrote ${out.pathname}`);
