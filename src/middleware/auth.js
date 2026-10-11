import { auth, db } from "../firebase.js";
import { HttpError, forbidden, serialize } from "../lib/http.js";

// Verifies the Firebase ID token and loads the caller's profile from users/{uid}.
export async function authenticate(req, _res, next) {
  const match = (req.get("authorization") ?? "").match(/^Bearer (.+)$/);
  if (!match) throw new HttpError(401, "Missing bearer token");

  let decoded;
  try {
    decoded = await auth.verifyIdToken(match[1]);
  } catch {
    throw new HttpError(401, "Invalid or expired token");
  }

  const snap = await db.collection("users").doc(decoded.uid).get();
  req.auth = {
    uid: decoded.uid,
    email: decoded.email ?? null,
    emailVerified: decoded.email_verified === true,
    name: decoded.name ?? null,
  };
  req.user = snap.exists ? serialize(snap) : null;
  next();
}

// Requires an active profile, optionally with one of the given roles.
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) throw forbidden("Profile not found. Complete sign-up via POST /api/me first.");
    if (req.user.status === "pending") throw forbidden("Your account is awaiting admin approval");
    if (req.user.status !== "active") throw forbidden("Your account is disabled");
    if (roles.length && !roles.includes(req.user.role)) throw forbidden();
    next();
  };
