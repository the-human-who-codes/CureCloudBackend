import { auth, db } from "../firebase.js";
import { problem } from "../lib/problem.js";

// Verifies the Firebase ID token and loads the caller's profile from users/{uid}. The profile keeps
// Firestore types (it is only used for policy checks); it is serialized through redact() when returned.
export async function authenticate(req, _res, next) {
  const match = (req.get("authorization") ?? "").match(/^Bearer (.+)$/);
  if (!match) throw problem("unauthenticated", "Missing bearer token");

  let decoded;
  try {
    decoded = await auth.verifyIdToken(match[1]);
  } catch {
    throw problem("unauthenticated", "Invalid or expired token");
  }

  const snap = await db.collection("users").doc(decoded.uid).get();
  req.auth = {
    uid: decoded.uid,
    email: decoded.email?.toLowerCase() ?? null,
    emailVerified: decoded.email_verified === true,
    name: decoded.name ?? null,
    picture: decoded.picture ?? null,
  };
  req.user = snap.exists ? { id: snap.id, ...snap.data() } : null;
  next();
}
