import { z } from "zod";

export const ROLES = ["patient", "doctor", "nurse", "admin"];
export const STAFF_ROLES = ["doctor", "nurse"];
export const USER_STATUSES = ["active", "pending", "disabled"];
export const PRIORITIES = ["stable", "moderate", "high", "critical"];
export const APPOINTMENT_STATUSES = ["pending", "confirmed", "cancelled", "completed"];
export const PRESCRIPTION_STATUSES = ["active", "completed", "discontinued"];

export const id = z.string().trim().min(1).max(128);
export const name = z.string().trim().min(2).max(120);
export const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, "Invalid phone number");
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
export const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm (24h)");
export const shortText = z.string().trim().min(1).max(200);
export const longText = z.string().trim().max(5000);

export const vitals = z
  .object({
    bloodPressure: z.string().regex(/^\d{2,3}\/\d{2,3}$/, "Expected e.g. 120/80"),
    heartRate: z.number().int().min(20).max(250),
    weight: z.number().min(0.5).max(500),
    bloodSugar: z.number().min(10).max(1000),
    temperature: z.number().min(30).max(45),
    oxygenSaturation: z.number().min(50).max(100),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one vital is required");

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
