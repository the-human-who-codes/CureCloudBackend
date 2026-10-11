// Fields never returned to other users (PII).
const PRIVATE_FIELDS = ["nationalId"];

export function publicUser(user, { includePrivate = false } = {}) {
  if (!user) return null;
  const out = { ...user };
  if (!includePrivate) for (const f of PRIVATE_FIELDS) delete out[f];
  return out;
}
