// UserPreferences (§2.15) and SystemSettings (§2.16). Both are read with defaults filled in and
// patched with a deep merge.
import { LANGUAGES, ResourceRef, csv, email, id, isoTimestamp, listQuery, opt, page, phone, text, timeOfDay } from "./common.js";
import { z } from "./zod.js";

const timeZones = new Set(Intl.supportedValuesOf("timeZone"));
export const timeZone = z
  .string()
  .refine((tz) => timeZones.has(tz) || tz === "UTC", "Unknown IANA time zone")
  .openapi({ example: "Africa/Johannesburg" });

export const DEFAULT_PREFERENCES = {
  notifications: { inApp: true, email: false, sms: false },
  language: "en",
  timeZone: "Africa/Johannesburg",
};

export const UserPreferences = z
  .object({
    notifications: z.object({ inApp: z.boolean(), email: z.boolean(), sms: z.boolean() }),
    language: z.enum(LANGUAGES),
    timeZone: z.string(),
    updatedAt: isoTimestamp.nullable(),
  })
  .openapi("UserPreferences");

export const PreferencesUpdateRequest = z
  .object({
    notifications: z.object({ inApp: z.boolean(), email: z.boolean(), sms: z.boolean() }).partial().strict(),
    language: z.enum(LANGUAGES),
    timeZone,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("PreferencesUpdateRequest");

// --- System settings ----------------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  organisationName: "CureCloud",
  supportEmail: null,
  supportPhone: null,
  defaultTimeZone: "Africa/Johannesburg",
  defaultLanguage: "en",
  appointments: {
    defaultDurationMinutes: 30,
    bookingWindowDays: 90,
    minLeadTimeMinutes: 60,
    patientCancellationCutoffHours: 2,
    openingHours: { start: "08:00", end: "16:30", days: [1, 2, 3, 4, 5] },
  },
  security: { sessionTimeoutMinutes: 30 },
  maintenanceBanner: null,
};

const quarterHour = timeOfDay.refine((t) => Number(t.slice(3)) % 15 === 0, "Must be on a 15-minute boundary");

export const OpeningHours = z
  .object({
    start: quarterHour,
    end: quarterHour,
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, "days must not repeat"),
  })
  .strict()
  .refine((h) => h.start < h.end, "start must be before end")
  .openapi("OpeningHours");

const appointmentSettings = {
  defaultDurationMinutes: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
  bookingWindowDays: z.number().int().min(1).max(365),
  minLeadTimeMinutes: z.number().int().min(0).max(1440),
  patientCancellationCutoffHours: z.number().int().min(0).max(72),
  openingHours: OpeningHours,
};

export const SystemSettings = z
  .object({
    organisationName: z.string(),
    supportEmail: z.string().nullable(),
    supportPhone: z.string().nullable(),
    defaultTimeZone: z.string(),
    defaultLanguage: z.enum(LANGUAGES),
    appointments: z.object({
      defaultDurationMinutes: z.number().int(),
      bookingWindowDays: z.number().int(),
      minLeadTimeMinutes: z.number().int(),
      patientCancellationCutoffHours: z.number().int(),
      openingHours: z.object({ start: z.string(), end: z.string(), days: z.array(z.number().int()) }),
    }),
    security: z.object({ sessionTimeoutMinutes: z.number().int() }),
    maintenanceBanner: z.string().nullable(),
    updatedAt: isoTimestamp.nullable(),
  })
  .openapi("SystemSettings");

export const SystemSettingsUpdateRequest = z
  .object({
    organisationName: text(120),
    supportEmail: email.nullable(),
    supportPhone: phone.nullable(),
    defaultTimeZone: timeZone,
    defaultLanguage: z.enum(LANGUAGES),
    appointments: z.object(appointmentSettings).partial().strict(),
    security: z.object({ sessionTimeoutMinutes: z.number().int().min(5).max(480) }).partial().strict(),
    maintenanceBanner: text(300).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("SystemSettingsUpdateRequest");

// --- System alerts (§2.17) ----------------------------------------------------------------------

export const ALERT_SEVERITIES = ["info", "warning", "critical"];
export const ALERT_STATUSES = ["active", "resolved"];

export const SystemAlert = z
  .object({
    id,
    title: z.string(),
    message: z.string(),
    severity: z.enum(ALERT_SEVERITIES),
    status: z.enum(ALERT_STATUSES),
    source: z.literal("system"),
    facilityId: z.string().nullable(),
    resource: opt(ResourceRef),
    resolvedAt: opt(isoTimestamp),
    resolvedBy: opt(z.string()),
    createdAt: isoTimestamp,
    createdBy: z.string(),
    updatedAt: isoTimestamp,
    updatedBy: z.string(),
  })
  .openapi("SystemAlert");
export const SystemAlertPage = page(SystemAlert, "SystemAlertPage");

export const SystemAlertListQuery = listQuery
  .extend({ status: csv(ALERT_STATUSES).optional(), severity: csv(ALERT_SEVERITIES).optional() })
  .strict();
export const SystemAlertUpdateRequest = z
  .object({ status: z.literal("resolved") })
  .strict()
  .openapi("SystemAlertUpdateRequest");
