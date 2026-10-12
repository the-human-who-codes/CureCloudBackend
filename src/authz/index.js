// The one authorization module (docs/domain-model.md §3). Routes call requirePermission (role
// check), then load + authorize (relationship check), then redact before responding.
import { problem } from "../lib/problem.js";
import { hasPermission } from "./permissions.js";

export { ROLE_PERMISSIONS, hasPermission, permissionsFor } from "./permissions.js";
export * from "./rules.js";
export { authorize, can } from "./policy.js";
export { redact, writableFields } from "./redact.js";
export { dashboardSpecs, queries, reportSpecs, scoped } from "./scoped.js";
export { eq, indexServes, queryShapes, spec } from "./query.js";
export { getDoc, loadPatient, ownPatient, patientsById, resolvePatientFilter, visibleDocs } from "./loaders.js";

// Account status first (§3.1): only active accounts pass.
export function requireActive(user) {
  if (!user) throw problem("profile-required", "Complete sign-up with POST /api/v1/me first");
  if (user.status === "pending") throw problem("account-pending", "Your account is awaiting admin approval");
  if (user.status !== "active") throw problem("account-disabled", "Your account is disabled");
}

// `permission` may be a list: any one of them is enough (e.g. shift:manage or shift:handover).
export const requirePermission = (permission) => (req, _res, next) => {
  requireActive(req.user);
  const perms = [permission].flat();
  if (!perms.some((p) => hasPermission(req.user, p))) throw problem("forbidden", "You do not have permission to do this");
  next();
};
