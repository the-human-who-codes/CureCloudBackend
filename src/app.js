import { readFileSync } from "node:fs";
import express from "express";
import { errorHandler, notFound } from "./lib/problem.js";
import { cors } from "./middleware/cors.js";
import { docsRouter, serveOpenApiDocument } from "./openapi.js";
import { v1Router } from "./routes/v1/index.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const app = express();
app.disable("x-powered-by");
app.use(cors);
app.use(express.json({ limit: "100kb" }));
// API documentation: public and cacheable, so it is mounted before the no-store default.
app.get("/api/openapi.json", serveOpenApiDocument);
app.use("/api/docs", docsRouter());
// Health data must never be cached by the Hosting CDN or browsers.
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Unversioned for uptime checks.
app.get("/api/health", (_req, res) => res.json({ status: "ok", version }));
app.use("/api/v1", v1Router());
app.use("/api", () => {
  throw notFound("route");
});
app.use(errorHandler);
