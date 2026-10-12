// Migrates stored documents to the v1 domain model (docs/domain-model.md §6). Dry run by default.
//
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run migrate                 # emulator, dry run
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run migrate -- --apply      # emulator, write
//   npm run migrate -- --project <id> --confirm <id> [--apply]             # a real project (owner only)
//
// Options: --default-facility-name "<name>" (used when no facility exists yet),
//          --default-facility-id <id> (the fallback facility when several already exist).
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { formatReport, runMigration } from "./lib/migrate.js";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    project: { type: "string" },
    confirm: { type: "string" },
    "default-facility-name": { type: "string" },
    "default-facility-id": { type: "string" },
  },
});

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
if (!emulator && !(values.project && values.confirm === values.project)) {
  console.error(
    "Refusing to run: set FIRESTORE_EMULATOR_HOST, or pass --project <id> --confirm <id> with the same value.",
  );
  process.exit(1);
}

const projectId = values.project ?? process.env.GCLOUD_PROJECT ?? "demo-curecloud";
console.log(`Target: ${emulator ? `emulator ${emulator}` : "LIVE Firestore"}, project ${projectId}`);

const db = getFirestore(initializeApp({ projectId }));
const report = await runMigration(db, {
  apply: values.apply,
  ...(values["default-facility-name"] && { defaultFacilityName: values["default-facility-name"] }),
  ...(values["default-facility-id"] && { defaultFacilityId: values["default-facility-id"] }),
});
console.log(formatReport(report));
