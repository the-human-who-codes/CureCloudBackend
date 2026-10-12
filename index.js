import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import { app } from "./src/app.js";
import { patientIdentifierKey } from "./src/lib/identifiers.js";

// Same region as the Firestore database. maxInstances caps cost if the API is ever hammered; raise it when traffic grows.
setGlobalOptions({ region: "africa-south1", maxInstances: 3 });

export const api = onRequest({ secrets: [patientIdentifierKey] }, app);
