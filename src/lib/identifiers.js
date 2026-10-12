// Keyed hashes for patientIdentifiers/{hash} (docs/domain-model.md §1.1), so identity numbers never
// appear in document paths or logs. The key is the PATIENT_IDENTIFIER_KEY secret; emulators and tests
// use the fixed demo key.
import { createHmac } from "node:crypto";
import { defineSecret } from "firebase-functions/params";

export const patientIdentifierKey = defineSecret("PATIENT_IDENTIFIER_KEY");
const DEMO_KEY = "demo-identifier-key";

function key() {
  const value = process.env.PATIENT_IDENTIFIER_KEY;
  if (value) return value;
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FUNCTIONS_EMULATOR === "true") return DEMO_KEY;
  throw new Error("PATIENT_IDENTIFIER_KEY is not configured");
}

export const normalizeIdentifierValue = (value) => value.replace(/\s+/g, "").toUpperCase();

export function identifierHash({ type, value }) {
  return createHmac("sha256", key()).update(`${type}:${normalizeIdentifierValue(value)}`).digest("hex");
}
