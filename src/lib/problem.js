// RFC 9457 problem+json errors (docs/domain-model.md §1.9). `detail` is shown to users, so it never
// contains PHI.
import { PROBLEM_BASE, PROBLEMS } from "../models/problem.js";

export class HttpProblem extends Error {
  constructor(code, detail, { errors } = {}) {
    super(detail ?? PROBLEMS[code]?.title ?? code);
    this.code = PROBLEMS[code] ? code : "internal";
    this.status = PROBLEMS[this.code].status;
    this.detail = detail;
    this.errors = errors;
  }

  toJSON() {
    const body = {
      type: `${PROBLEM_BASE}${this.code}`,
      title: PROBLEMS[this.code].title,
      status: this.status,
      code: this.code,
    };
    if (this.detail) body.detail = this.detail;
    if (this.errors) body.errors = this.errors;
    return body;
  }
}

export const problem = (code, detail, extra) => new HttpProblem(code, detail, extra);

export const badRequest = (detail) => new HttpProblem("validation-error", detail);
export const forbidden = (detail = "You do not have permission to do this") => new HttpProblem("forbidden", detail);
export const notFound = (what = "Resource") =>
  new HttpProblem("not-found", `${what.charAt(0).toUpperCase()}${what.slice(1)} not found`);
export const conflict = (detail, code = "conflict") => new HttpProblem(code, detail);
export const invalidTransition = (detail) => new HttpProblem("invalid-state-transition", detail);

// Field-level write denial that names the field (§3.4).
export const fieldForbidden = (field) => new HttpProblem("forbidden", `You may not change ${field}`);

// zod error → validation problem with dot-notation paths into the body or query.
export function validationProblem(zodError, prefix) {
  const errors = zodError.issues.map((issue) => ({
    path: [prefix, ...issue.path].filter((p) => p !== undefined && p !== "").join("."),
    message: issue.message,
    code: issue.code,
  }));
  const n = errors.length;
  return new HttpProblem("validation-error", `${n} field${n === 1 ? " is" : "s are"} invalid`, { errors });
}

export function sendProblem(res, err) {
  res.status(err.status).type("application/problem+json").send(JSON.stringify(err.toJSON()));
}

// Express error handler. Unknown errors become 500 internal without leaking the message.
export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpProblem) return sendProblem(res, err);
  if (err?.type === "entity.parse.failed") return sendProblem(res, new HttpProblem("malformed-json"));
  if (err?.type === "entity.too.large") return sendProblem(res, badRequest("Request body is too large"));
  // Never log bodies (PHI); the route template and caller are enough to investigate.
  console.error(`Unhandled error on ${req.method} ${req.route?.path ?? req.path} uid=${req.user?.id ?? "-"}`, err);
  return sendProblem(res, new HttpProblem("internal"));
}
