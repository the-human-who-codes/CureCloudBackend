// System settings (docs/domain-model.md §2.16): missing fields fall back to defaults; cached for 60 s.
import { db } from "../firebase.js";
import { DEFAULT_SETTINGS } from "../models/preferences.js";

const TTL_MS = 60e3;
let cache = null;

export const settingsRef = () => db.collection("systemSettings").doc("global");

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v) && !(typeof v.toDate === "function");

export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = isObject(v) && isObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// Only the known keys, so stray stored fields never reach responses or business rules.
export function withDefaults(stored = {}) {
  const pick = (defaults, value) =>
    Object.fromEntries(
      Object.entries(defaults).map(([k, d]) => [
        k,
        isObject(d) && !Array.isArray(d) ? pick(d, value?.[k] ?? {}) : (value?.[k] ?? d),
      ]),
    );
  return { ...pick(DEFAULT_SETTINGS, stored), updatedAt: stored.updatedAt ?? null };
}

export async function getSettings() {
  if (cache && cache.expires > Date.now()) return cache.value;
  const snap = await settingsRef().get();
  const value = withDefaults(snap.exists ? snap.data() : {});
  cache = { value, expires: Date.now() + TTL_MS };
  return value;
}

export const invalidateSettings = () => {
  cache = null;
};
