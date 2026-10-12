// GET/POST/PATCH /me response (§4.2).
import { Patient } from "./patient.js";
import { User } from "./user.js";
import { z } from "./zod.js";

export const MeResponse = z
  .object({ user: User, patient: Patient.nullable(), permissions: z.array(z.string()) })
  .openapi("MeResponse");

export const HealthResponse = z.object({ status: z.literal("ok"), version: z.string() }).openapi("Health");
