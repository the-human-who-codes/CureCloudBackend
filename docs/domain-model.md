# CureCloud domain model and API contract (v1)

Status: **accepted design, to be implemented in one iteration** on the `domain-models` branches of
CureCloudBackend and CureCloud. This file is the single source of truth for entity shapes, the authorization
model, the HTTP API, and which endpoints each frontend page uses. If code and this document disagree, fix
whichever is wrong in the same change and keep them in sync.

Scope rules for this iteration:

- Prefer fewer, well-shaped entities. Everything marked **Deferred** is out of scope; the UI must hide or
  remove those controls rather than fake them with mock data.
- Breaking API changes are allowed (the only client ships in lockstep). Every breaking change is listed in
  [section 4.3](#43-breaking-changes-against-the-current-api).
- Production (`curecloud1`) is nearly empty. Shape changes go through the idempotent migration in
  [section 6](#6-data-migration).

Contents

1. [Conventions](#1-conventions)
2. [Entities](#2-entities)
3. [Authorization model](#3-authorization-model)
4. [API surface](#4-api-surface)
5. [Page to endpoint mapping](#5-page-to-endpoint-mapping)
6. [Data migration](#6-data-migration)
7. [Deferred](#7-deferred)
8. [Implementation notes](#8-implementation-notes)

---

## 1. Conventions

### 1.1 Identifiers

- Document IDs are opaque strings. Clients never parse or construct them.
- Default: Firestore auto IDs (20 characters).
- `users/{uid}` uses the Firebase Auth UID. A patient who has an account has a `patients/{uid}` document with
  the same ID; walk-in patients get an auto ID and `userId: null`. Code must use `patient.userId` to link a
  patient to an account. Never rely on the two IDs being equal.
- Deterministic IDs are used only where they enforce a uniqueness rule:

  | Collection                  | ID                                          | Rule enforced                                |
  | --------------------------- | ------------------------------------------- | -------------------------------------------- |
  | `appointmentSlots`          | `{doctorId}_{epochMillis}`                  | A doctor cannot be double-booked             |
  | `medicationAdministrations` | `{prescriptionId}_{epochMillis}` (scheduled doses only) | A scheduled dose is charted only once |
  | `userPreferences`           | `{uid}`                                     | One preferences document per user            |
  | `patientIdentifiers`        | `sha256("{type}:{value}")` hex              | One patient per national ID or passport      |
  | `conversations` (direct)    | `direct_{uidA}_{uidB}` (UIDs sorted)        | One direct conversation per pair of users    |

  `patientIdentifiers` uses a hash so that identity numbers never show up in document paths or logs.

### 1.2 Time

- Instants are stored as Firestore `Timestamp` and serialized as ISO 8601 UTC with milliseconds:
  `2026-10-12T07:00:00.000Z`.
- Request instants must carry an offset (`2026-10-12T09:00:00+02:00` or `...Z`). Instants without an offset
  are rejected with `400`.
- Calendar dates with no time (birth date, prescription start/end) are `YYYY-MM-DD` strings.
- Wall-clock times of day (medication administration times) are `HH:mm` strings in facility local time.
- Business rules that depend on "today", "this morning" and similar are evaluated in `Africa/Johannesburg`
  (SAST, UTC+2, no DST). `src/lib/dates.js` owns this.

### 1.3 Audit fields and schema version

Every stored document has these fields. The server sets them and ignores them in request bodies.

| Field           | Type             | Notes                                                          |
| --------------- | ---------------- | -------------------------------------------------------------- |
| `createdAt`     | timestamp        | Server time on create                                          |
| `createdBy`     | string           | User ID, or `"system"` for server-generated documents          |
| `updatedAt`     | timestamp        | Server time on every write (equals `createdAt` on create)      |
| `updatedBy`     | string           | User ID or `"system"`                                          |
| `schemaVersion` | integer          | `2` for every document written by v1 code. Not serialized      |

Subcollection documents and embedded objects do not repeat audit fields unless their entity says so.

Denormalized display names (`patientName`, `doctorName`, `authorName` and so on) are **snapshots taken at
write time**. They are not rewritten when someone is renamed. They exist so list views do not need extra
reads.

### 1.4 Clinical data retention (never hard-delete)

- Clinical records are **never hard-deleted** through the API: patients, vitals, prescriptions, medication
  administrations, medical records, appointments, admissions and messages. There are no `DELETE` endpoints
  for them.
- Mistakes are corrected with a status transition to `entered-in-error`, which requires a `statusReason`. The
  document stays in place and is excluded from default list results. Staff can still list it with
  `?status=entered-in-error`.
- Finalized medical records are immutable. Corrections are appended as **addenda**
  ([2.11](#211-medicalrecord)).
- Patients are deactivated (`status: "inactive"` or `"deceased"`), never removed.
- Non-clinical configuration (facilities, departments, channels) is archived with `status: "archived"`.
- Only relationship rows and ephemera are hard-deleted: care team membership
  (`DELETE /patients/{id}/care-team/{userId}`), appointment slot locks (released on cancel or reschedule),
  and notifications (Firestore TTL on `expiresAt`, 90 days; the TTL policy is an ops step, see
  [7](#7-deferred)).
- Fields removed by the migration are moved to a `legacy` map on the same document, never silently
  dropped. `legacy` is never serialized.

### 1.5 Enums and naming

- Enum values are lowercase kebab-case: `no-show`, `entered-in-error`, `in-progress`.
- The only exceptions are domain notations: blood type (`A+`, `O-`), ICD-10 codes (`E11.9`) and ISO country
  codes (`ZA`).
- JSON field names are camelCase. Collections are camelCase plurals. URL path segments are kebab-case
  plurals (`/medical-records`, `/care-tasks`).
- People's names: `name` is the display name (2 to 120 characters, required). `givenName` and `familyName`
  are optional structured parts. A lowercase `nameLower` copy is stored for sorting and prefix search but
  is not serialized.
- Phone numbers are stored as E.164 (`+27821234567`). The API accepts local SA formats (`082 123 4567`) and
  normalizes them.
- Emails are trimmed and lowercased.

### 1.6 Money

There are no monetary fields in v1. The budget and revenue widgets are removed because CureCloud targets
public hospitals. If money is ever needed, it is stored as `{ amountCents: integer, currency: "ZAR" }`.

### 1.7 Request and response format

- JSON only. Request bodies are validated with zod `.strict()` schemas, so unknown fields return `400`.
- Clients must ignore unknown response fields. Additive changes are not breaking.
- Single resources are returned as the bare object: `GET /patients/{id}` returns `Patient`.
- `POST` that creates a resource returns `201`, a `Location` header and the created resource.
- Responses for lists are always:

  ```json
  { "data": [ ... ], "nextCursor": "b3BhcXVl..." }
  ```

  `nextCursor` is `null` on the last page.
- `Cache-Control: no-store` on every response (unchanged).

### 1.8 Pagination

- Every list endpoint accepts `limit` (1 to 100, default 25) and `cursor` (opaque).
- The cursor is base64url of the last returned document's path. The server loads that snapshot and calls
  `startAfter(snapshot)`, which costs 1 extra read per page. It fetches `limit + 1` documents to decide
  whether `nextCursor` is set. If the cursor document is invalid or missing, the server returns `400`.
- Every list has a fixed, documented sort order with the document ID as tie-breaker.
- Endpoints that are bounded by construction are not paginated and say so: medication schedule for one day,
  dashboard, reports, care team, preferences.

### 1.9 Errors: RFC 9457 problem details

Every error response is `Content-Type: application/problem+json`:

```json
{
  "type": "https://curecloud1.web.app/problems/validation-error",
  "title": "Invalid request",
  "status": 400,
  "detail": "2 fields are invalid",
  "code": "validation-error",
  "errors": [
    { "path": "start", "message": "Expected an ISO 8601 instant with offset", "code": "invalid_string" }
  ]
}
```

- `type` is `https://curecloud1.web.app/problems/{code}`. `code` is an extension member with the same slug,
  added for client convenience.
- `errors` is present only for validation failures. Its `path` is dot-notation into the body or query.
- `instance` is omitted. Request IDs are logged server-side only.
- `detail` is safe to show to users and never contains PHI.

| Code                       | Status | When                                                                         |
| -------------------------- | ------ | ---------------------------------------------------------------------------- |
| `validation-error`         | 400    | Body or query failed validation                                              |
| `malformed-json`           | 400    | Body is not valid JSON                                                       |
| `invalid-cursor`           | 400    | Pagination cursor cannot be decoded or does not exist                        |
| `unauthenticated`          | 401    | Missing, invalid or expired bearer token                                     |
| `profile-required`         | 403    | Signed in but no `users` document (call `POST /me`)                          |
| `account-pending`          | 403    | Staff account awaiting approval                                              |
| `account-disabled`         | 403    | Account disabled                                                             |
| `forbidden`                | 403    | Role lacks the permission, or a field-level rule denies the write            |
| `not-found`                | 404    | Resource missing **or not visible to the caller** (see [3.5](#35-denial-semantics)) |
| `conflict`                 | 409    | Generic uniqueness conflict (profile exists, email exists)                   |
| `slot-unavailable`         | 409    | Appointment slot already booked                                              |
| `invalid-state-transition` | 409    | Status change not allowed from the current status                            |
| `record-immutable`         | 409    | Edit attempted on a final medical record or a terminal resource              |
| `duplicate-identifier`     | 409    | Another patient already has this national ID or passport                     |
| `already-charted`          | 409    | Scheduled dose already has an administration                                 |
| `internal`                 | 500    | Unexpected error (the message is never leaked)                               |

The frontend `ApiError` exposes `status`, `code`, `message` (= `detail ?? title`) and `errors`.

### 1.10 Versioning

- All endpoints live under `/api/v1`. With the function URL that gives
  `https://africa-south1-curecloud1.cloudfunctions.net/api/api/v1/...`. The client appends `/v1` to
  `VITE_API_BASE_URL`, so the env files do not change.
- The unversioned `/api/*` routes are removed in this iteration because the only client moves at the same
  time. `GET /api/health` stays unversioned for uptime checks.
- Within v1 only additive changes are allowed: new endpoints, new optional request fields, new response
  fields and new enum values on response-only fields. A breaking change means `/api/v2`, served side by
  side until the client migrates.

### 1.11 API documentation (OpenAPI / Swagger)

- The zod request and response schemas are the single source. They are registered with
  `@asteasolutions/zod-to-openapi` (zod 3 compatible) to generate an **OpenAPI 3.1** document.
- `GET /api/v1/openapi.json` serves the spec. `GET /api/docs` serves Swagger UI (`swagger-ui-express`). Both
  are public: they contain no data or secrets.
- Every route registers its path, its `x-permission` (the permission string from section 3), its
  parameters, its request body, its responses and its problem types. Security scheme: `bearerAuth` (HTTP
  bearer, Firebase ID token).
- The README endpoint table is deleted and replaced with a link to `/api/docs` and to this document.
- A test asserts that every Express route is in the spec and that the spec validates.

### 1.12 Data classification

POPIA classifies health information as *special personal information*. Each field below has one of these
classes:

| Class      | Meaning                                                    | Examples                                  |
| ---------- | ---------------------------------------------------------- | ----------------------------------------- |
| `public`   | Safe for any signed-in user                                | facility name, department name            |
| `internal` | Staff directory data                                       | staff name, role, specialization          |
| `PII`      | Personal information                                       | phone, email, address, emergency contact  |
| `PII-high` | Identity documents; field-level restricted                 | national ID, passport number              |
| `PHI`      | Health information                                         | vitals, diagnoses, prescriptions, notes, messages, appointment reason |

Rules: never log request or response bodies. Log IDs, route templates, status codes and the caller UID only.
PHI is never put in notification text beyond what the recipient can already see. PHI is never put in
`detail` messages.

---

## 2. Entities

Notation: `?` means optional (may be absent or `null`). Types use TypeScript-like syntax. Timestamps are ISO
strings in the API. All entities carry the audit fields from [1.3](#13-audit-fields-and-schema-version),
which are not repeated below. The class column applies the classes from [1.12](#112-data-classification).

### Shared value types

```ts
type Address = {
  line1: string;            // 1–200
  line2?: string;           // ≤200
  suburb?: string;          // ≤100
  city: string;             // 1–100
  province: Province;
  postalCode: string;       // ^\d{4}$
  country: string;          // ISO 3166-1 alpha-2, default "ZA"
};
type Province = "eastern-cape" | "free-state" | "gauteng" | "kwazulu-natal" | "limpopo"
              | "mpumalanga" | "north-west" | "northern-cape" | "western-cape";

type EmergencyContact = { name: string; relationship: string /* ≤50 */; phone: string };

type Identifier = {
  type: "za-id" | "passport" | "asylum-seeker-permit" | "other";
  value: string;            // za-id: 13 digits, valid date and Luhn check; others ^[A-Za-z0-9-]{4,20}$
  country?: string;         // ISO alpha-2; required for passport
};

type ResourceRef = { type: "appointment" | "prescription" | "medical-record" | "care-task"
                         | "conversation" | "user" | "patient"; id: string };
```

If a `za-id` is supplied and `birthDate` or `sex` is missing, the server derives them from the ID number
(digits 1 to 6 give the date of birth; digits 7 to 10 below 5000 mean female, otherwise male).

### 2.1 User (account)

Collection `users/{uid}`. One document per Firebase Auth account. Holds authentication identity, role,
status and organisational scoping. For doctors and nurses it also holds the Practitioner profile, see
[2.2](#22-practitioner-profile).

| Field              | Type                                               | Req | Class    | Notes |
| ------------------ | -------------------------------------------------- | --- | -------- | ----- |
| `id`               | string                                             | ✓   | internal | Firebase UID |
| `email`            | string                                             | ✓   | PII      | From the Auth token, lowercased |
| `name`             | string                                             | ✓   | internal | Display name |
| `phone`            | string                                             |     | PII      | E.164 (renamed from `phoneNumber`) |
| `photoUrl`         | string (URL)                                       |     | internal | From the Google profile |
| `role`             | `"patient" \| "nurse" \| "doctor" \| "admin"`      | ✓   | internal | |
| `status`           | `"pending" \| "active" \| "disabled"`              | ✓   | internal | Patients start `active`; staff start `pending` |
| `statusReason`     | string ≤200                                        |     | internal | Set when disabling or rejecting |
| `facilityId`       | string                                             |     | internal | Required to activate staff. `null` on an admin means **system admin** |
| `departmentId`     | string                                             |     | internal | Required for nurses before activation; optional for doctors |
| `identifier`       | Identifier                                         |     | PII-high | Staff only (from signup). Replaces `nationalId` |
| `emergencyContact` | EmergencyContact                                   |     | PII      | |
| `practitioner`     | Practitioner                                       |     | internal | Present iff `role` is `doctor` or `nurse` |
| `lastSignInAt`     | timestamp                                          |     | internal | **Not stored.** Read from Firebase Auth metadata on admin list and detail reads |

Status transitions: `pending → active` (approve), `pending → disabled` (reject, `statusReason` required),
`active ↔ disabled`. Changing status keeps Firebase Auth `disabled` in sync, and disabling also calls
`revokeRefreshTokens`.

Invariants:

- Patients cannot become staff and staff cannot become patients.
- Nobody can change their own role or status.
- The last active system admin cannot be demoted or disabled (`409 conflict`).

Indexes: see [2.19](#219-index-summary). Lists sort by `nameLower`.

### 2.2 Practitioner profile

Embedded at `users/{uid}.practitioner`, so the authorization middleware still needs only one read per
request. Exposed through the User resource and the practitioner directory.

| Field              | Type                                          | Req | Class    | Notes |
| ------------------ | --------------------------------------------- | --- | -------- | ----- |
| `licenceBody`      | `"hpcsa" \| "sanc"`                           | ✓   | internal | HPCSA for doctors, SANC for nurses (derived from role) |
| `licenceNumber`    | string `^[A-Za-z0-9/-]{4,20}$`                |     | internal | Required before activation. Only an admin edits it after activation |
| `specialization`   | string ≤100                                   |     | internal | e.g. "Cardiology", "General Practice" |
| `qualifications`   | `{ title, institution, year: integer }[]` ≤10 |     | internal | |
| `practisingSince`  | integer (year)                                |     | internal | UI shows years of experience |
| `officeLocation`   | string ≤200                                   |     | internal | "Block A, Floor 3, Room 302" |
| `bio`              | string ≤1000                                  |     | internal | |

Self-editable fields (`PATCH /me`): `specialization`, `qualifications`, `practisingSince`, `officeLocation`,
`bio`. Admin-editable fields (`PATCH /users/{id}`): all of them.

`PractitionerSummary` is the directory projection: `{ id, name, role, specialization, photoUrl, facilityId,
facilityName, departmentId, departmentName }`. Facility and department names are resolved per request with
`getAll`.

### 2.3 Facility

Collection `facilities/{id}`. Usually a hospital.

| Field      | Type                                                       | Req | Class  |
| ---------- | ---------------------------------------------------------- | --- | ------ |
| `name`     | string 2–120                                               | ✓   | public |
| `type`     | `"hospital" \| "clinic" \| "community-health-centre"`      | ✓   | public |
| `address`  | Address                                                    |     | public |
| `phone`    | string                                                     |     | public |
| `email`    | string                                                     |     | public |
| `status`   | `"active" \| "archived"`                                   | ✓   | public |

The migration creates `facilities/default` if no facility exists ([6](#6-data-migration)).

### 2.4 Department

Collection `departments/{id}`. A top-level collection with `facilityId`, which keeps queries simple. A
department doubles as the ward used for nurse scoping.

| Field         | Type                     | Req | Class    | Notes |
| ------------- | ------------------------ | --- | -------- | ----- |
| `facilityId`  | string                   | ✓   | public   | |
| `name`        | string 2–120             | ✓   | public   | Unique per facility (case-insensitive) |
| `headId`      | string                   |     | internal | Active doctor or nurse in the same facility |
| `headName`    | string                   |     | internal | Snapshot |
| `location`    | string ≤200              |     | public   | |
| `phone`       | string                   |     | public   | |
| `bedCapacity` | integer ≥0               | ✓   | public   | 0 means an outpatient department |
| `status`      | `"active" \| "archived"` | ✓   | public   | |

`DepartmentStats` is computed when `?include=stats` is passed, admins only: `{ staff, doctors, nurses,
admittedPatients, occupancyRate (0–1 or null when bedCapacity = 0), appointmentsToday }`. It uses `count()`
aggregations.

### 2.5 Patient

Collection `patients/{id}`. Demographics, clinical summary and current admission.

| Field               | Type                                                         | Req | Class    | Notes |
| ------------------- | ------------------------------------------------------------ | --- | -------- | ----- |
| `id`                | string                                                       | ✓   | internal | |
| `userId`            | string                                                       |     | internal | Linked account, `null` for walk-ins |
| `facilityId`        | string                                                       |     | internal | Registering facility. Set on first booking if `null` |
| `status`            | `"active" \| "inactive" \| "deceased"`                       | ✓   | PHI      | Default `active` |
| `deceasedAt`        | date                                                         |     | PHI      | Required iff `status = deceased` |
| `name`              | string                                                       | ✓   | PII      | |
| `givenName`         | string ≤60                                                   |     | PII      | |
| `familyName`        | string ≤60                                                   |     | PII      | |
| `birthDate`         | date                                                         |     | PII      | Renamed from `dateOfBirth` |
| `sex`               | `"female" \| "male" \| "intersex" \| "unknown"`              | ✓   | PHI      | Administrative sex as on ID documents. Default `unknown` |
| `phone`             | string                                                       |     | PII      | |
| `email`             | string                                                       |     | PII      | |
| `address`           | Address                                                      |     | PII      | |
| `emergencyContact`  | EmergencyContact                                             |     | PII      | |
| `identifier`        | Identifier                                                   |     | PII-high | Readable only by self and admin ([3.4](#34-field-level-rules)). Unique through `patientIdentifiers` |
| `bloodType`         | `"A+" \| "A-" \| "B+" \| "B-" \| "AB+" \| "AB-" \| "O+" \| "O-"` |  | PHI      | |
| `allergies`         | `Allergy[]` ≤50                                              | ✓   | PHI      | Default `[]` |
| `noKnownAllergies`  | boolean                                                      | ✓   | PHI      | `true` only when `allergies` is empty. It separates "no known allergies" from "not yet recorded" |
| `chronicConditions` | `Condition[]` ≤50                                            | ✓   | PHI      | Default `[]` |
| `acuity`            | `"stable" \| "moderate" \| "high" \| "critical"`             | ✓   | PHI      | Renamed from `priority`. Default `stable` |
| `admission`         | Admission                                                    |     | PHI      | Current inpatient stay, or `null` |
| `careTeam`          | string[] ≤50                                                 | ✓   | internal | User IDs of doctors and nurses. Managed only through the care team endpoints |
| `latestVitals`      | VitalSigns subset + `recordedAt`                             |     | PHI      | Renamed from `vitals`. Denormalized, see [2.6](#26-vitalsigns-observation) |

```ts
type Allergy   = { substance: string /* ≤100 */; reaction?: string /* ≤200 */;
                   severity: "mild" | "moderate" | "severe"; notedOn?: string /* date */ };
type Condition = { name: string /* ≤120 */; code?: string /* ICD-10, ^[A-Z]\d{2}(\.\d{1,2})?$ */;
                   since?: string /* date */; notes?: string /* ≤500 */ };
type Admission = { departmentId: string; departmentName: string /* snapshot */; ward?: string;
                   room?: string; bed?: string; admittedAt: string; admittedBy: string;
                   attendingDoctorId?: string };
```

Stored but not serialized: `nameLower` (search), `conditionCategories: string[]` (the 3-character ICD-10
prefixes of `chronicConditions[].code`, used by reports) and `legacy`.

Admission history: discharge appends the closed admission (plus `dischargedAt`, `dischargedBy`,
`dischargeNote?`) to the subcollection `patients/{id}/admissions/{autoId}` and sets `admission: null`.
There is no read endpoint for the history in v1 (**Deferred**).

### 2.6 VitalSigns (Observation)

Subcollection `patients/{patientId}/vitals/{id}`. Each document is one panel of readings taken at the same
time. This is modelled after FHIR's vital-signs Observation profile, kept as a panel because that is how
nurses capture readings.

| Field              | Type                                     | Unit         | Range      |
| ------------------ | ---------------------------------------- | ------------ | ---------- |
| `patientId`        | string                                   |              |            |
| `recordedAt`       | timestamp                                |              | Not in the future, at most 7 days in the past. Default now |
| `status`           | `"final" \| "entered-in-error"`          |              |            |
| `statusReason`     | string ≤200                              |              | Required with `entered-in-error` |
| `bloodPressure`    | `{ systolic: int, diastolic: int }`      | mmHg         | 50–260 / 20–160, systolic > diastolic |
| `heartRate`        | int                                      | beats/min    | 20–250     |
| `respiratoryRate`  | int                                      | breaths/min  | 4–60       |
| `temperature`      | number (1 dp)                            | °C           | 30–45      |
| `oxygenSaturation` | int                                      | %            | 50–100     |
| `bloodGlucose`     | number (1 dp)                            | mmol/L       | 0.5–50 (renamed from `bloodSugar` mg/dL, see [6](#6-data-migration)) |
| `weight`           | number (1 dp)                            | kg           | 0.5–500    |
| `height`           | number                                   | cm           | 20–250     |
| `painScore`        | int                                      | 0–10         |            |
| `notes`            | string ≤500                              |              |            |
| `createdByName`    | string                                   |              | Snapshot   |

At least one measurement is required. All fields are PHI. `patient.latestVitals` is the field-wise merge of
final panels, newest first, plus the most recent `recordedAt`. It is written in the same batch as the
create. When a panel is marked `entered-in-error`, `latestVitals` is rebuilt from the 10 most recent final
panels.

### 2.7 Appointment

Collection `appointments/{id}`. Slot locks live in `appointmentSlots/{doctorId}_{epochMillis}` as
`{ doctorId, start, appointmentId }`, with one lock per 15-minute unit.

| Field                | Type                                              | Req | Class    | Notes |
| -------------------- | ------------------------------------------------- | --- | -------- | ----- |
| `patientId`          | string                                            | ✓   | internal | |
| `patientName`        | string                                            | ✓   | PII      | Snapshot |
| `patientUserId`      | string                                            |     | internal | For notifications |
| `doctorId`           | string                                            | ✓   | internal | |
| `doctorName`         | string                                            | ✓   | internal | Snapshot |
| `facilityId`         | string                                            | ✓   | internal | Copied from the doctor |
| `departmentId`       | string                                            |     | internal | Copied from the doctor |
| `start`              | timestamp                                         | ✓   | PHI      | Aligned to a 15-minute boundary (SAST). Replaces `date` + `time` + `scheduledAt` |
| `end`                | timestamp                                         | ✓   | PHI      | `start + durationMinutes` |
| `durationMinutes`    | `15 \| 30 \| 45 \| 60`                            | ✓   | PHI      | Default from system settings (30) |
| `type`               | `"check-up" \| "consultation" \| "follow-up" \| "procedure" \| "test" \| "vaccination" \| "other"` | ✓ | PHI | Default `check-up` |
| `reason`             | string ≤1000                                      |     | PHI      | Reason for the visit. Replaces `notes`. Hidden from admins |
| `status`             | see lifecycle                                     | ✓   | PHI      | |
| `cancellationReason` | string ≤200                                       |     | PHI      | |
| `cancelledBy`        | string                                            |     | internal | |
| `checkedInAt`        | timestamp                                         |     | PHI      | |

Lifecycle (modelled on FHIR Appointment):

```
pending ──▶ confirmed ──▶ checked-in ──▶ completed
   │            │  │            │
   │            │  └────────────┴──▶ no-show   (also confirmed ──▶ completed)
   └────────────┴──▶ cancelled
```

| Transition                                     | Allowed callers (subject to [3](#3-authorization-model)) | Guard |
| ---------------------------------------------- | -------------------------------------------------------- | ----- |
| `pending → confirmed`                          | doctor (own), admin                                       | |
| `pending\|confirmed → cancelled`               | patient (own), doctor (own), admin                        | Patients only until `patientCancellationCutoffHours` before `start` |
| `confirmed → checked-in`                       | nurse (clinical access or same department), doctor (own), admin | `now ≥ start − 2h` |
| `confirmed\|checked-in → completed`            | doctor (own)                                              | `now ≥ start` |
| `confirmed\|checked-in → no-show`              | doctor (own), admin                                       | `now ≥ start` |
| reschedule (`start` and/or `durationMinutes`)  | patient (own: back to `pending`), doctor (own), admin (status kept unless set) | Only while `pending\|confirmed` |

`cancelled`, `completed` and `no-show` are terminal. Cancelling or rescheduling releases the old slot locks
in the same transaction. Booking checks:

- The doctor is active.
- `now + minLeadTimeMinutes ≤ start ≤ now + bookingWindowDays`.
- All 15-minute slot locks for the duration are free (otherwise `409 slot-unavailable`).

Booking adds the doctor to `patient.careTeam`, as it does today, and sets `patient.facilityId` if it is null.

### 2.8 Prescription (MedicationRequest)

Collection `prescriptions/{id}`.

| Field                 | Type                                   | Req | Class    | Notes |
| --------------------- | -------------------------------------- | --- | -------- | ----- |
| `patientId`           | string                                 | ✓   | internal | |
| `patientName`         | string                                 | ✓   | PII      | Snapshot |
| `prescriberId`        | string                                 | ✓   | internal | Renamed from `doctorId` |
| `prescriberName`      | string                                 | ✓   | internal | Renamed from `doctorName` |
| `category`            | `"inpatient" \| "outpatient"`          | ✓   | PHI      | Defaults to `inpatient` when the patient is admitted. Only inpatient prescriptions appear in the nurse medication schedule |
| `medication`          | string 1–200                           | ✓   | PHI      | Free text drug name (coded drug catalogue is **Deferred**) |
| `dose`                | string 1–50                            | ✓   | PHI      | "500 mg". Renamed from `dosage` |
| `route`               | `"oral" \| "sublingual" \| "iv" \| "im" \| "sc" \| "topical" \| "inhaled" \| "rectal" \| "ophthalmic" \| "otic" \| "nasal" \| "other"` | ✓ | PHI | Default `oral` |
| `frequency`           | see table                              | ✓   | PHI      | Replaces free-text frequency |
| `frequencyText`       | string ≤100                            |     | PHI      | Required iff `frequency = custom` |
| `administrationTimes` | `HH:mm[]` ≤12                          | ✓   | PHI      | Defaults from `frequency`; required non-empty for `custom` |
| `instructions`        | string ≤2000                           |     | PHI      | Renamed from `notes` |
| `refills`             | int 0–12                               | ✓   | PHI      | Default 0 |
| `startDate`           | date                                   | ✓   | PHI      | |
| `endDate`             | date                                   |     | PHI      | `≥ startDate` |
| `status`              | `"active" \| "on-hold" \| "completed" \| "stopped" \| "entered-in-error"` | ✓ | PHI | `discontinued` migrates to `stopped` |
| `statusReason`        | string ≤200                            |     | PHI      | Required for `on-hold`, `stopped`, `entered-in-error` |
| `appointmentId`       | string                                 |     | internal | |

| `frequency`          | Default `administrationTimes`         |
| -------------------- | ------------------------------------- |
| `once`               | the start time (single dose on `startDate`) |
| `once-daily`         | `08:00`                               |
| `twice-daily`        | `08:00, 20:00`                        |
| `three-times-daily`  | `08:00, 14:00, 20:00`                 |
| `four-times-daily`   | `06:00, 12:00, 18:00, 22:00`          |
| `every-4-hours`      | `02:00, 06:00, 10:00, 14:00, 18:00, 22:00` |
| `every-6-hours`      | `00:00, 06:00, 12:00, 18:00`          |
| `every-8-hours`      | `06:00, 14:00, 22:00`                 |
| `at-night`           | `21:00`                               |
| `weekly`             | `08:00` on the weekday of `startDate` |
| `as-needed`          | none (PRN)                            |
| `custom`             | must be supplied                      |

Status transitions:

- `active → on-hold | completed | stopped | entered-in-error`
- `on-hold → active | stopped | entered-in-error`
- Everything else is terminal.

Who may make them:

- The prescriber, or any doctor with clinical access, may hold, resume or stop.
- Only the prescriber may set `entered-in-error`, and only if no `completed` administration exists
  (otherwise `409 invalid-state-transition`; use `stopped`).

While a prescription is `active` or `on-hold`, only `endDate`, `refills`, `instructions` and
`administrationTimes` are editable. Changing the drug, dose, route or frequency means stopping it and
prescribing again, which keeps the record of what was ordered intact.

A prescription is *current* when `status = active` and `startDate ≤ today ≤ (endDate ?? ∞)`. Automatic
completion after `endDate` is **Deferred**; lists and the schedule apply the date window instead.

### 2.9 MedicationAdministration

Collection `medicationAdministrations/{id}`. The ID is deterministic for scheduled doses
([1.1](#11-identifiers)) and an auto ID for PRN doses.

| Field            | Type                                                       | Req | Class    | Notes |
| ---------------- | ---------------------------------------------------------- | --- | -------- | ----- |
| `prescriptionId` | string                                                     | ✓   | internal | |
| `patientId`      | string                                                     | ✓   | internal | |
| `patientName`    | string                                                     | ✓   | PII      | Snapshot |
| `medication`     | string                                                     | ✓   | PHI      | Snapshot from the prescription |
| `dose`           | string                                                     | ✓   | PHI      | Dose actually given (defaults to the prescription's) |
| `route`          | route enum                                                 | ✓   | PHI      | |
| `scheduledFor`   | timestamp                                                  |     | PHI      | The schedule slot. `null` for PRN |
| `occurredAt`     | timestamp                                                  | ✓   | PHI      | Default now, at most 24h in the past, never in the future |
| `status`         | `"completed" \| "not-done" \| "entered-in-error"`          | ✓   | PHI      | |
| `statusReason`   | `"patient-refused" \| "patient-unavailable" \| "clinically-held" \| "medication-unavailable" \| "other"` | | PHI | Required for `not-done` |
| `notes`          | string ≤500                                                |     | PHI      | |
| `performerId`    | string                                                     | ✓   | internal | |
| `performerName`  | string                                                     | ✓   | internal | Snapshot |

**Medication schedule** (computed, not stored). `GET /medication-schedule?date=` takes the caller's
accessible inpatients, their current inpatient prescriptions and each prescription's `administrationTimes`
for that date (SAST). It loads the matching administrations by deterministic ID with `getAll` and returns
one item per dose:

```ts
type ScheduledDose = {
  prescriptionId: string; patientId: string; patientName: string;
  room?: string; bed?: string; allergies: string[];   // allergy substances, for UI warnings
  medication: string; dose: string; route: string; instructions?: string;
  scheduledFor: string;
  status: "upcoming" | "due" | "overdue" | "given" | "not-given";
  administrationId?: string;
};
```

Status rules:

- `due`: within ±30 minutes of `scheduledFor`.
- `overdue`: more than 30 minutes past `scheduledFor` and not charted.
- `upcoming`: everything earlier than the due window.
- `given` and `not-given`: taken from the administration's status.

PRN prescriptions are returned separately as `prn: PrescriptionSummary[]`. Drug interaction checking is
**Deferred**.

### 2.10 CareTask

Collection `careTasks/{id}`. Nursing work items.

| Field            | Type                                                                          | Req | Class    | Notes |
| ---------------- | ----------------------------------------------------------------------------- | --- | -------- | ----- |
| `patientId`      | string                                                                        |     | internal | `null` for ward-level tasks |
| `patientName`    | string                                                                        |     | PII      | Snapshot |
| `facilityId`     | string                                                                        | ✓   | internal | |
| `departmentId`   | string                                                                        | ✓   | internal | Default: the patient's admission department, otherwise the creator's department |
| `title`          | string 1–200                                                                  | ✓   | PHI      | |
| `description`    | string ≤2000                                                                  |     | PHI      | |
| `category`       | `"vitals" \| "medication" \| "assessment" \| "wound-care" \| "hygiene" \| "mobility" \| "specimen" \| "doctor-round" \| "admin" \| "other"` | ✓ | internal | |
| `priority`       | `"low" \| "normal" \| "high" \| "urgent"`                                     | ✓   | internal | Default `normal` |
| `dueAt`          | timestamp                                                                     | ✓   | internal | |
| `status`         | `"open" \| "in-progress" \| "completed" \| "cancelled"`                       | ✓   | internal | |
| `assigneeId`     | string                                                                        |     | internal | `null` means unassigned (visible to the department) |
| `assigneeName`   | string                                                                        |     | internal | Snapshot |
| `startedAt`      | timestamp                                                                     |     | internal | |
| `completedAt`    | timestamp                                                                     |     | internal | |
| `completedBy`    | string                                                                        |     | internal | |
| `completionNote` | string ≤1000                                                                  |     | PHI      | |

Transitions: `open → in-progress → completed`, `in-progress → open` (release), `open|in-progress →
cancelled` (creator or any doctor, reason in `completionNote`). Completed and cancelled tasks are terminal.
Any nurse in the department may claim an unassigned task (`assigneeId` set to themselves) or reassign within
the department. Assigning a task to someone notifies them.

### 2.11 MedicalRecord

Collection `medicalRecords/{id}`. Clinical documents: encounter and consultation notes, nursing notes and
lab reports. This is a simplified FHIR Composition and DiagnosticReport.

| Field             | Type                                                                | Req | Class    | Notes |
| ----------------- | ------------------------------------------------------------------- | --- | -------- | ----- |
| `patientId`       | string                                                              | ✓   | internal | |
| `patientName`     | string                                                              | ✓   | PII      | Snapshot |
| `authorId`        | string                                                              | ✓   | internal | Renamed from `doctorId` |
| `authorName`      | string                                                              | ✓   | internal | Renamed from `doctorName` |
| `authorRole`      | `"doctor" \| "nurse"`                                               | ✓   | internal | |
| `category`        | `"consultation" \| "progress-note" \| "nursing-note" \| "lab-result" \| "imaging" \| "procedure" \| "discharge-summary" \| "referral"` | ✓ | PHI | Nurses may only create `nursing-note` |
| `title`           | string 1–200                                                        | ✓   | PHI      | Replaces the free-text `type` |
| `effectiveAt`     | timestamp                                                           | ✓   | PHI      | Clinically relevant time. Default now, not in the future. Lists sort by it |
| `status`          | `"preliminary" \| "final" \| "amended" \| "entered-in-error"`       | ✓   | PHI      | Default `final` |
| `statusReason`    | string ≤200                                                         |     | PHI      | Required for `entered-in-error` |
| `diagnosis`       | string ≤5000                                                        |     | PHI      | |
| `diagnosisCode`   | ICD-10 string                                                       |     | PHI      | |
| `findings`        | string ≤5000                                                        |     | PHI      | Renamed from `results` |
| `treatment`       | string ≤5000                                                        |     | PHI      | |
| `recommendations` | string ≤5000                                                        |     | PHI      | |
| `labResults`      | `LabResult[]` ≤50                                                   |     | PHI      | For `lab-result` |
| `appointmentId`   | string                                                              |     | internal | Must belong to the same patient |
| `addenda`         | `Addendum[]`                                                        | ✓   | PHI      | Append-only, default `[]` |

```ts
type LabResult = { name: string /* ≤120, e.g. "HbA1c" */; code?: string /* LOINC */;
                   value: string /* ≤50 */; unit?: string; referenceRange?: string;
                   flag: "normal" | "low" | "high" | "critical-low" | "critical-high" | "abnormal" };
type Addendum  = { text: string /* 1–5000 */; authorId: string; authorName: string; createdAt: string };
```

At least one of `diagnosis`, `findings`, `treatment` or `labResults` is required.

Lifecycle:

- `preliminary` is editable by the author.
- `preliminary → final` is done by the author.
- When a record is `final` or `amended`, its content is immutable (`409 record-immutable`). The author may
  append an addendum, which sets status to `amended`.
- The author may set `entered-in-error` from any status.
- Patients see only `final` and `amended` records.
- Finalising a record notifies the patient. The notification says "New medical record: {title}" and
  contains no clinical content.

### 2.12 Shift (staff schedule)

Collection `shifts/{id}`.

| Field           | Type                                                               | Req | Class    | Notes |
| --------------- | ------------------------------------------------------------------ | --- | -------- | ----- |
| `staffId`       | string                                                             | ✓   | internal | Doctor, nurse or admin |
| `staffName`     | string                                                             | ✓   | internal | Snapshot |
| `staffRole`     | role                                                               | ✓   | internal | Snapshot |
| `facilityId`    | string                                                             | ✓   | internal | |
| `departmentId`  | string                                                             |     | internal | Default: the staff member's department |
| `type`          | `"morning" \| "afternoon" \| "night" \| "day" \| "on-call" \| "leave"` | ✓ | internal | `leave` blocks the time and counts as "On leave" |
| `start`, `end`  | timestamp                                                          | ✓   | internal | `end > start`, at most 24h long. No overlap for the same staff member (`409 conflict`) |
| `status`        | `"scheduled" \| "cancelled"`                                       | ✓   | internal | |
| `handoverNote`  | string ≤2000                                                       |     | PHI      | Written by the shift owner for the next shift |
| `handoverAt`    | timestamp                                                          |     | internal | |

"On duty" (computed) means `status = scheduled`, `type ≠ leave` and `start ≤ now < end`. Shift queries use
`start` in `[from − 24h, to)` and filter `end > from` in memory, which is valid because shifts are at most
24h long. Recurring rotas and doctor booking availability templates are **Deferred**.

### 2.13 Notification

Collection `notifications/{id}`. Per-user inbox, written only by the server.

| Field         | Type                                                                                       | Req | Notes |
| ------------- | ------------------------------------------------------------------------------------------ | --- | ----- |
| `userId`      | string                                                                                     | ✓   | Recipient |
| `type`        | `"appointment" \| "prescription" \| "medical-record" \| "care-task" \| "message" \| "account" \| "system"` | ✓ | `record` migrates to `medical-record` |
| `title`       | string ≤120                                                                                | ✓   | |
| `description` | string ≤500                                                                                | ✓   | No clinical detail beyond what the recipient can already see |
| `priority`    | `"normal" \| "important"`                                                                  | ✓   | |
| `resource`    | ResourceRef                                                                                |     | Deep link target |
| `read`        | boolean                                                                                    | ✓   | |
| `readAt`      | timestamp                                                                                  |     | |
| `expiresAt`   | timestamp                                                                                  | ✓   | `createdAt + 90 days`. Firestore TTL field. Not serialized |

Events that notify:

| Event                                               | Recipient           |
| --------------------------------------------------- | ------------------- |
| Booking request                                     | Doctor              |
| Booking by staff                                    | Patient             |
| Appointment status change or reschedule            | The other party     |
| New or stopped prescription                         | Patient             |
| Refill request                                      | Prescriber          |
| Record finalised                                    | Patient             |
| Task assigned                                       | Assignee            |
| Account approved or disabled                        | User                |
| Added to a care team                                | Staff member        |

New messages do not create notifications; the conversation list shows unread counts instead.

### 2.14 Conversation and Message

Collection `conversations/{id}`, messages in `conversations/{id}/messages/{id}`. REST only in v1; the client
polls every 15 s while a conversation is open. Realtime is **Deferred** (see [7](#7-deferred)).

Conversation:

| Field            | Type                                                    | Req | Notes |
| ---------------- | ------------------------------------------------------- | --- | ----- |
| `type`           | `"direct" \| "group" \| "channel" \| "patient"`         | ✓   | |
| `title`          | string ≤100                                             |     | Required for `group` and `channel` |
| `facilityId`     | string                                                  | ✓   | |
| `departmentId`   | string                                                  |     | `channel` only. `null` means a facility-wide channel |
| `patientId`      | string                                                  |     | Required for `patient` |
| `participantIds` | string[] 2–50                                           | ✓   | Empty for `channel` (membership is implicit) |
| `participants`   | `{ [uid]: { name, role } }`                             | ✓   | Display snapshot |
| `lastMessage`    | `{ text (≤140), senderId, senderName, sentAt }`         |     | |
| `lastMessageAt`  | timestamp                                               | ✓   | Sort key (equals `createdAt` until the first message) |
| `lastReadAt`     | `{ [uid]: timestamp }`                                  | ✓   | Not serialized. The API returns `unreadCount` for the caller instead |
| `status`         | `"active" \| "archived"`                                | ✓   | |

Type rules:

- `direct`: exactly 2 active staff in the same facility. The ID is deterministic, so creating it twice
  returns the existing one.
- `group`: 3 to 50 staff.
- `channel`: created by an admin. Any active staff member of the facility (or of the department, when
  `departmentId` is set) can read and post.
- `patient`: participants are the patient's `userId` plus at least one doctor or nurse on the patient's
  care team. It can be created by the patient or by such a staff member.

Message (PHI): `{ id, senderId, senderName, senderRole, text (1–4000), createdAt }`. Messages are
append-only in v1. Editing, deleting, attachments, reactions and quick-response templates are **Deferred**.

`unreadCount` is the `count()` of messages with `createdAt > lastReadAt[caller]`. It is computed only for
the conversations on the returned page.

### 2.15 UserPreferences

Document `userPreferences/{uid}`. `GET` returns the defaults when the document does not exist.

| Field           | Type                                           | Default                 |
| --------------- | ---------------------------------------------- | ----------------------- |
| `notifications` | `{ inApp: boolean, email: boolean, sms: boolean }` | `{ true, false, false }` (email and SMS delivery are **Deferred**; the values are stored only) |
| `language`      | `"en" \| "af" \| "zu" \| "xh"`                 | `en` (only English UI copy exists in v1) |
| `timeZone`      | IANA zone (validated with `Intl.supportedValuesOf`) | `Africa/Johannesburg` |
| `theme`         | `"light" \| "dark" \| "system"`                | `light`                 |
| `calendarView`  | `"day" \| "week" \| "month"`                   | `week`                  |
| `listView`      | `"list" \| "grid" \| "table"`                  | `list`                  |

Class: internal. Audit fields: `updatedAt` and `updatedBy` only.

### 2.16 SystemSettings

Document `systemSettings/global`. Readable by every active user. Only a system admin may write it. Missing
fields fall back to the defaults below. The server caches the document in memory for 60 s.

| Field                                         | Type          | Default         | Enforced by |
| --------------------------------------------- | ------------- | --------------- | ----------- |
| `organisationName`                            | string ≤120   | `"CureCloud"`   | UI          |
| `supportEmail`, `supportPhone`                | string        | `null`          | UI          |
| `defaultTimeZone`                             | IANA          | `Africa/Johannesburg` | UI defaults |
| `defaultLanguage`                             | language enum | `en`            | UI defaults |
| `appointments.defaultDurationMinutes`         | 15/30/45/60   | 30              | API         |
| `appointments.bookingWindowDays`              | int 1–365     | 90              | API         |
| `appointments.minLeadTimeMinutes`             | int 0–1440    | 60              | API         |
| `appointments.patientCancellationCutoffHours` | int 0–72      | 2               | API         |
| `security.sessionTimeoutMinutes`              | int 5–480     | 30              | UI (idle sign-out) |
| `maintenanceBanner`                           | string ≤300   | `null`          | UI (banner for all users) |

Facility contact details live on Facility, not here. Backups, integrations, IP allowlists and password
policy are not app settings: Firebase or GCP handles them, or they are **Deferred**.

### 2.17 SystemAlert

Collection `systemAlerts/{id}`. Operational alerts for admins, shared rather than per-user.

| Field        | Type                                     | Req | Notes |
| ------------ | ---------------------------------------- | --- | ----- |
| `title`      | string ≤120                              | ✓   | |
| `message`    | string ≤500                              | ✓   | No PHI |
| `severity`   | `"info" \| "warning" \| "critical"`      | ✓   | |
| `status`     | `"active" \| "resolved"`                 | ✓   | |
| `source`     | `"system" \| "manual"`                   | ✓   | |
| `facilityId` | string                                   |     | `null` means system-wide |
| `resource`   | ResourceRef                              |     | |
| `resolvedAt`, `resolvedBy` | timestamp, string          |     | |

The system raises one alert per staff signup ("New doctor signup awaiting approval", with a resource link to
the user). The alert is resolved automatically when that user is approved or rejected.

### 2.18 Reports (aggregation only, nothing stored)

`GET /reports/summary` returns a `ReportSummary` computed on request. Scope comes from the caller (see
[3.3](#33-relationship-and-attribute-rules)):

- doctor: their care-team patients, their appointments and their prescriptions.
- nurse: their department and their care-team patients.
- facility admin: their facility.
- system admin: everything, or `?facilityId=`.

```ts
type ReportSummary = {
  scope: { type: "practitioner" | "department" | "facility" | "system"; id: string | null };
  period: { from: string; to: string };                     // default: last 30 days
  patients: { total: number; newInPeriod: number;
              byAcuity: Record<Acuity, number>; bySex: Record<Sex, number>;
              byAgeGroup: { "0-17": number; "18-34": number; "35-49": number; "50-64": number; "65+": number; unknown: number };
              topConditions: { category: string; name: string; count: number }[] };   // top 10 ICD-10 categories
  appointments: { total: number; byStatus: Record<AppointmentStatus, number>;
                  byType: Record<AppointmentType, number>;
                  byDay: { date: string; count: number }[]; byHour: { hour: number; count: number }[] };
  prescriptions: { active: number; newInPeriod: number; topMedications: { name: string; count: number }[] } | null; // null for nurses
  departments: { departmentId: string; name: string; staff: number; admittedPatients: number;
                 bedCapacity: number; occupancyRate: number | null; appointments: number }[] | null;  // admins only
  meta: { generatedAt: string; truncated: boolean };
};
```

Implementation: a bounded scan with `select()` projections of the scoped patients, the appointments in the
period and the prescriptions, capped at 2,000 documents per collection (`meta.truncated` is set when the cap
is hit), aggregated in memory. The period is at most 366 days. CSV export is done client-side from this
JSON. Stored or scheduled report generation is **Deferred**.

`GET /dashboard` returns small role-specific counters that use `count()` aggregations
([4.2](#42-endpoint-catalogue)).

### 2.19 Index summary

Composite indexes for `firestore.indexes.json`. Single-field indexes are automatic. `__name__` ordering is
implicit.

| Collection                  | Fields                                                                 | Used by |
| --------------------------- | ---------------------------------------------------------------------- | ------- |
| `users`                     | `role, status, nameLower`                                              | directory, admin list |
| `users`                     | `facilityId, nameLower` · `facilityId, role, nameLower` · `facilityId, status, nameLower` · `facilityId, role, status, nameLower` | admin list (scoped) |
| `users`                     | `role, nameLower` · `status, nameLower`                                | system admin list |
| `users`                     | `departmentId, role, status, nameLower`                                | department directory |
| `patients`                  | `careTeam CONTAINS, nameLower`                                         | clinician list (kept) |
| `patients`                  | `careTeam CONTAINS, acuity, nameLower`                                 | acuity filter, critical count |
| `patients`                  | `admission.departmentId, nameLower` · `admission.departmentId, acuity, nameLower` | ward nurse list (OR branch) |
| `patients`                  | `facilityId, nameLower`                                                | admin list |
| `appointments`              | `patientId, start` · `doctorId, start` · `departmentId, start` · `facilityId, start` | lists (replace the `scheduledAt` indexes) |
| `appointments`              | `patientId, status, start` · `doctorId, status, start` · `departmentId, status, start` · `facilityId, status, start` | status filters, counters |
| `appointmentSlots`          | `doctorId, start`                                                      | busy times |
| `prescriptions`             | `patientId, createdAt DESC` · `patientId, status, createdAt DESC`       | lists (kept) |
| `prescriptions`             | `prescriberId, createdAt DESC` · `prescriberId, status, createdAt DESC` | prescriber lists (replace the `doctorId` ones) |
| `medicationAdministrations` | `patientId, occurredAt DESC` · `prescriptionId, occurredAt DESC` · `performerId, occurredAt DESC` | history |
| `medicalRecords`            | `patientId, effectiveAt DESC` · `patientId, status, effectiveAt DESC` · `patientId, category, effectiveAt DESC` | patient lists |
| `medicalRecords`            | `authorId, effectiveAt DESC` · `authorId, status, effectiveAt DESC`     | author lists, preliminary count |
| `careTasks`                 | `assigneeId, status, dueAt` · `departmentId, status, dueAt` · `patientId, status, dueAt` | task lists |
| `careTasks`                 | `completedBy, completedAt DESC`                                        | completed today |
| `shifts`                    | `staffId, start` · `departmentId, start` · `facilityId, start`         | rosters |
| `shifts`                    | `departmentId, end DESC`                                               | previous handover |
| `notifications`             | `userId, createdAt DESC` · `userId, read, createdAt DESC`               | kept |
| `conversations`             | `participantIds CONTAINS, lastMessageAt DESC` · `facilityId, type, lastMessageAt DESC` | conversation list |
| `systemAlerts`              | `status, createdAt DESC` · `facilityId, status, createdAt DESC`         | alert list |
| `departments`               | `facilityId, name`                                                     | department list |

---

## 3. Authorization model

### 3.1 Principles

1. **One policy module.** `src/lib/policy.js` holds every authorization decision. Routes do not compare
   roles or IDs inline.
2. **Two layers.**
   - *Role permissions* (`resource:action`) answer "can this role ever do X?".
   - *Relationship and attribute rules* answer "can this user do X to this particular resource?".
   - Field-level redaction is a third pass applied to every response.
3. **Account status first.** Only `status = active` accounts pass, except `GET /me` and `POST /me`.
4. **Least privilege for admins.** Admins manage accounts, organisation, scheduling and demographics. They
   have **no access to clinical content** (vitals, prescriptions, administrations, medical records, care
   tasks, appointment reasons, clinical patient fields). Emergency "break-glass" access is **Deferred**.
5. **Deny by default.** A permission that is not in the matrix is denied.

### 3.2 Role to permission matrix

✓ means the role has the permission, subject to the relationship rule in the last column (rules are defined
in [3.3](#33-relationship-and-attribute-rules)). A blank cell means denied.

| Permission                          | patient | nurse | doctor | admin | Relationship / attribute rule |
| ----------------------------------- | :-----: | :---: | :----: | :---: | ----------------------------- |
| `profile:read`, `profile:update`    | ✓ | ✓ | ✓ | ✓ | self |
| `preferences:read`, `preferences:update` | ✓ | ✓ | ✓ | ✓ | self |
| `dashboard:read`                    | ✓ | ✓ | ✓ | ✓ | own scope |
| `practitioner:list`                 | ✓ | ✓ | ✓ | ✓ | patients get `PractitionerSummary` of active doctors only |
| `user:list`, `user:read`, `user:update` |   |   |   | ✓ | facility |
| `facility:read`                     | ✓ | ✓ | ✓ | ✓ | active facilities |
| `facility:manage`                   |   |   |   | ✓ | system admin |
| `department:read`                   |   | ✓ | ✓ | ✓ | same facility (system admin: all) |
| `department:manage`                 |   |   |   | ✓ | facility |
| `patient:list`                      |   | ✓ | ✓ | ✓ | clinical (nurse, doctor), facility (admin) |
| `patient:read`                      | ✓ | ✓ | ✓ | ✓ | self / clinical / facility (demographics only) |
| `patient:create`                    |   | ✓ | ✓ | ✓ | created in the caller's facility. Nurse and doctor creators join the care team |
| `patient:update`                    | ✓ | ✓ | ✓ | ✓ | field sets per [3.4](#34-field-level-rules) |
| `patient:read-identifier`           | ✓ | | | ✓ | self / facility |
| `patient:manage-care-team`          |   |   | ✓ | ✓ | doctor: add only, while on the care team. Admin: add and remove, facility |
| `patient:admit`                     |   | ✓ | ✓ | ✓ | doctor and admin: admit, transfer, discharge. Nurse: transfer room or bed within their department only |
| `vitals:read`                       | ✓ | ✓ | ✓ |   | self / clinical |
| `vitals:create`                     |   | ✓ | ✓ |   | clinical |
| `vitals:retract`                    |   | ✓ | ✓ |   | author |
| `appointment:read`                  | ✓ | ✓ | ✓ | ✓ | own (patient) / own or clinical (doctor) / clinical or same department (nurse) / facility without `reason` (admin) |
| `appointment:create`                | ✓ | ✓ | ✓ | ✓ | self / clinical / facility |
| `appointment:update`                | ✓ | ✓ | ✓ | ✓ | transition table in [2.7](#27-appointment) |
| `practitioner:read-busy`            | ✓ | ✓ | ✓ | ✓ | any active doctor (returns times only) |
| `prescription:read`                 | ✓ | ✓ | ✓ |   | self / clinical |
| `prescription:create`               |   |   | ✓ |   | clinical |
| `prescription:update`               |   |   | ✓ |   | prescriber, or clinical for hold, resume and stop |
| `prescription:request-refill`       | ✓ |   |   |   | self, outpatient, current, `refills > 0` |
| `medication-administration:read`    | ✓ | ✓ | ✓ |   | self / clinical |
| `medication-administration:create`  |   | ✓ | ✓ |   | clinical, prescription `active` |
| `medication-administration:retract` |   | ✓ | ✓ |   | performer |
| `medication-schedule:read`          |   | ✓ | ✓ |   | clinical patients (nurse: plus ward) |
| `medical-record:read`               | ✓ | ✓ | ✓ |   | self (`final` and `amended` only) / clinical |
| `medical-record:create`             |   | ✓ | ✓ |   | clinical. Nurses: `nursing-note` only |
| `medical-record:update`             |   | ✓ | ✓ |   | author (edit while preliminary, finalise, addendum, retract) |
| `care-task:read`                    |   | ✓ | ✓ |   | nurse: department, assignee or creator. Doctor: creator, or clinical for the task's patient |
| `care-task:create`                  |   | ✓ | ✓ |   | patient tasks need clinical access |
| `care-task:update`                  |   | ✓ | ✓ |   | nurse: department or assignee. Doctor: creator |
| `shift:read`                        |   | ✓ | ✓ | ✓ | own + same facility roster |
| `shift:manage`                      |   |   |   | ✓ | facility |
| `shift:handover`                    |   | ✓ | ✓ | ✓ | shift owner |
| `notification:read`, `notification:update` | ✓ | ✓ | ✓ | ✓ | owner |
| `conversation:read`, `conversation:create`, `message:create` | ✓ | ✓ | ✓ | ✓ | participant / channel member. Patients: `patient` type only, with their care team. Staff in a `patient` conversation must still have clinical access |
| `channel:manage`                    |   |   |   | ✓ | facility |
| `system-settings:read`              | ✓ | ✓ | ✓ | ✓ | |
| `system-settings:update`            |   |   |   | ✓ | system admin |
| `system-alert:read`, `system-alert:manage` | | |   | ✓ | facility (system admin: all) |
| `report:read`                       |   | ✓ | ✓ | ✓ | scope per [2.18](#218-reports-aggregation-only-nothing-stored) |

`GET /me` returns the caller's role permissions as `permissions: string[]`. The UI uses them to show or
hide actions. The server still enforces every rule.

### 3.3 Relationship and attribute rules

These are pure functions over `(user, resource)`, defined once in `policy.js`:

| Rule          | Definition |
| ------------- | ---------- |
| `self`        | `resource.userId === user.id` (patient, notification, preferences), or `resource.id === user.id` (user) |
| `careTeam`    | `patient.careTeam.includes(user.id)` |
| `ward`        | `user.role === "nurse" && user.departmentId && patient.admission?.departmentId === user.departmentId` |
| `clinical`    | `user.role ∈ {doctor, nurse} && (careTeam \|\| ward)`. Child resources (vitals, prescriptions, records, administrations, tasks) inherit it from their patient |
| `author`      | `resource.createdBy === user.id` (also `authorId`, `performerId` or `prescriberId` per entity) |
| `facility`    | `user.facilityId === null` (system admin) `\|\| resource.facilityId === user.facilityId \|\| resource.facilityId === null` (unassigned records are visible to every admin) |
| `department`  | `resource.departmentId === user.departmentId` |
| `participant` | `conversation.participantIds.includes(user.id)`, or for channels `facility && (conversation.departmentId == null \|\| department)` |
| `active`      | `user.status === "active"`. Checked once in middleware |

Patient access levels: `patientAccess(user, patient)` returns one of these values, and every patient-scoped
decision uses it:

- `"self"`: the patient's own account.
- `"clinical"`: a doctor or nurse who passes the `clinical` rule.
- `"administrative"`: an admin who passes the `facility` rule.
- `null`: no access, which is surfaced as `404`.

### 3.4 Field-level rules

Applied by `redact(user, type, doc)` on every serialized document, including list items and embedded
snapshots.

| Entity.field                                                          | Visible to |
| --------------------------------------------------------------------- | ---------- |
| `Patient.identifier`                                                  | self, administrative |
| `Patient.{allergies, noKnownAllergies, chronicConditions, bloodType, latestVitals}` | self, clinical |
| Other `Patient` fields                                                | self, clinical, administrative |
| `User.{identifier, emergencyContact, phone}`                          | self, admin (facility) |
| `User.email`                                                          | self, admin. Staff colleagues see email in the directory; patients never do |
| `User.lastSignInAt`                                                   | admin |
| `Appointment.{reason, cancellationReason}`                            | patient (own), doctor, nurse with access. Not admin |
| `MedicalRecord` with status `preliminary` or `entered-in-error`       | Hidden from the patient: the row is excluded, not just redacted |
| `Conversation.lastReadAt`                                             | never (replaced by the caller's `unreadCount`) |
| `legacy`, `nameLower`, `conditionCategories`, `expiresAt`, `schemaVersion` | never |

Writable field sets for `PATCH /patients/{id}`. Any field outside the caller's set returns `403 forbidden`
and names the field:

| Access level     | Writable fields |
| ---------------- | --------------- |
| `self`           | `name, givenName, familyName, phone, email, address, emergencyContact`, plus `identifier` only while it is `null` |
| `clinical`       | `name, givenName, familyName, birthDate, sex, phone, email, address, emergencyContact, bloodType, allergies, noKnownAllergies, chronicConditions, acuity`. Doctors also: `status, deceasedAt`. Staff can set `identifier` **only on `POST /patients`** (write-only) |
| `administrative` | `name, givenName, familyName, birthDate, sex, phone, email, address, emergencyContact, identifier, facilityId, status` (`inactive` or `active` only) |

### 3.5 Denial semantics

- Not signed in returns `401`. Inactive account returns `403 account-pending` or `403 account-disabled`.
- **The role lacks the permission** (the matrix cell is blank) returns `403 forbidden`. For example, a
  patient calling `POST /prescriptions`.
- **The role has the permission but no relationship to the resource** returns `404 not-found`. For example,
  a doctor reading a patient who is not on their care team. This means resource IDs cannot be probed.
- **The resource is visible but this action or field is not allowed** returns `403 forbidden`. For example,
  a nurse finalising a doctor's preliminary record, or a patient patching `acuity`.
- **Business rule or state violation** returns `409` with the specific code.

### 3.6 Module shape

```js
// src/lib/policy.js
export const ROLE_PERMISSIONS = { patient: [...], nurse: [...], doctor: [...], admin: [...] };

export function hasPermission(user, permission);                 // matrix only
export function patientAccess(user, patient);                    // "self" | "clinical" | "administrative" | null
export function can(user, action, resource, context = {});       // matrix + relationship rules → boolean
export function authorize(user, action, resource, context = {}); // throws HttpProblem per 3.5
export function redact(user, type, doc, context = {});           // field-level rules
export function writableFields(user, type, resource);            // for PATCH validation

// Scoped query builders: always use these for lists, never raw collection queries in routes.
export const scoped = {
  patients(user, { q, acuity }),          // careTeam / Filter.or(careTeam, ward) / facility
  appointments(user, filters),
  prescriptions(user, filters),
  medicalRecords(user, filters),
  careTasks(user, filters),
  shifts(user, filters),
  conversations(user, filters),
  users(user, filters),
};

// Express helpers
export const requirePermission = (permission) => (req, _res, next) => { ... };
export async function loadPatient(user, patientId, action);      // get + authorize, returns redacted-ready doc
```

- Routes call `requirePermission(...)` (role check), then `loadX` + `authorize` (relationship check), then
  `redact` before responding.
- `requireRole` and `src/lib/access.js` are removed.
- `policy.js` has no Firestore writes and the predicates are pure, so most of it is unit-tested without
  emulators (`test/policy.test.js`).

---

## 4. API surface

### 4.1 Conventions recap

- Base path `/api/v1`. Bearer Firebase ID token on everything except the public endpoints marked below.
- Lists take `?limit=&cursor=` and return `{ data, nextCursor }`. Single resources are bare objects.
  Creates return `201` with a `Location` header. Errors are problem+json.
- Multi-value filters are comma-separated: `?status=pending,confirmed` (at most 10 values, Firestore `in`).
- Time windows use `from` and `to`, both ISO instants, half-open `[from, to)`.
- The CORS allowed methods become `GET, POST, PATCH, DELETE, OPTIONS`.

Status column: **E** existing and unchanged, **C** changed (breaking), **N** new, **R** removed.

### 4.2 Endpoint catalogue

#### Public

| St | Method | Path                    | Response | Notes |
| -- | ------ | ----------------------- | -------- | ----- |
| C  | GET    | `/api/health`           | `{ status: "ok", version }` | Unversioned. `version` comes from `package.json` |
| N  | GET    | `/api/v1/openapi.json`  | OpenAPI 3.1 | |
| N  | GET    | `/api/docs`             | Swagger UI | |
| C  | POST   | `/api/v1/auth/signup`   | `201 { id, status: "pending" }` | Body: `{ email, password (8–128), name, phone, role: "doctor"\|"nurse", identifier: Identifier, licenceNumber?, specialization? }`. Renamed `fullName → name`, `phoneNumber → phone`, `nationalId → identifier`. Raises a SystemAlert |

#### Me

| St | Method | Path               | Permission           | Request | Response |
| -- | ------ | ------------------ | -------------------- | ------- | -------- |
| C  | GET    | `/me`              | signed in (any status) | – | `{ user: User, patient: Patient \| null, permissions: string[] }`. `404 not-found` means onboarding is needed |
| C  | POST   | `/me`              | signed in, no profile | `{ name?, phone?, birthDate?, sex? }` | `201` with the same shape as `GET /me` |
| C  | PATCH  | `/me`              | `profile:update`     | `{ name?, phone?, emergencyContact?, practitioner?: { specialization?, qualifications?, practisingSince?, officeLocation?, bio? } }` | Same shape as `GET /me`. A name change is mirrored to the linked patient |
| N  | GET    | `/me/preferences`  | `preferences:read`   | – | `UserPreferences` (with defaults filled in) |
| N  | PATCH  | `/me/preferences`  | `preferences:update` | Partial `UserPreferences` (deep-merged) | `UserPreferences` |

#### Dashboard and reports

| St | Method | Path               | Permission       | Response |
| -- | ------ | ------------------ | ---------------- | -------- |
| N  | GET    | `/dashboard`       | `dashboard:read` | Role-specific (OpenAPI `oneOf` with discriminator `role`), not paginated. See the shapes below |
| N  | GET    | `/reports/summary?from=&to=&facilityId=&departmentId=` | `report:read` | `ReportSummary`. `facilityId` is for system admins; `departmentId` is for admins |
| R  | GET    | `/admin/stats`     | – | Replaced by `GET /dashboard` for admins |

Dashboard shapes (all counts are `count()` aggregations):

- `patient`: `{ role, counters: { upcomingAppointments, activePrescriptions, unreadNotifications } }`
- `doctor`: `{ role, counters: { patients, appointmentsToday, pendingAppointments, preliminaryRecords, activePrescriptions } }`
- `nurse`: `{ role, counters: { patientsUnderCare, tasksDueToday, medicationsDueNow, criticalPatients }, alerts: { type: "critical-patient" | "overdue-medication" | "overdue-task", patientId?, patientName?, message, at }[] }` (at most 10 alerts)
- `admin`: `{ role, counters: { doctors, nurses, patients, admittedPatients, pendingStaff, upcomingAppointments, activeSystemAlerts, totalUsers, activeUsers, disabledUsers } }`

#### Users, directory, organisation

| St | Method | Path                           | Permission          | Request / query | Response |
| -- | ------ | ------------------------------ | ------------------- | --------------- | -------- |
| C  | GET    | `/users?role=&status=&facilityId=&departmentId=&q=` | `user:list` | `q` is a case-insensitive prefix match on name | page of `User` (with `lastSignInAt`), sorted by `nameLower` |
| N  | GET    | `/users/{id}`                  | `user:read`         | – | `User` |
| C  | PATCH  | `/users/{id}`                  | `user:update`       | `{ role?: "doctor"\|"nurse"\|"admin", status?, statusReason?, facilityId?, departmentId?, practitioner?: Partial<Practitioner> }` | `User`. Activating staff requires `facilityId` (and `departmentId` for nurses, plus `practitioner.licenceNumber`); otherwise `400` |
| R  | GET    | `/doctors`                     | – | – | Replaced by `/practitioners?role=doctor` |
| N  | GET    | `/practitioners?role=&facilityId=&departmentId=&q=` | `practitioner:list` | Active staff only | page of `PractitionerSummary` (patients: doctors only) |
| N  | GET    | `/practitioners/{id}/busy?from=&to=` | `practitioner:read-busy` | Window at most 31 days | `{ data: { start, end }[] }` (not paginated, no PHI) |
| N  | GET    | `/facilities`                  | `facility:read`     | `?status=` (admin) | page of `Facility` |
| N  | POST   | `/facilities`                  | `facility:manage`   | `Facility` fields | `201 Facility` |
| N  | PATCH  | `/facilities/{id}`             | `facility:manage`   | partial (`status: "archived"` to archive) | `Facility` |
| N  | GET    | `/departments?facilityId=&include=stats` | `department:read` | `include=stats` is admin only | page of `Department` (+ `stats`) |
| N  | POST   | `/departments`                 | `department:manage` | `Department` fields | `201 Department` |
| N  | PATCH  | `/departments/{id}`            | `department:manage` | partial | `Department` |

#### Patients

| St | Method | Path                                         | Permission                 | Request / query | Response |
| -- | ------ | -------------------------------------------- | -------------------------- | --------------- | -------- |
| C  | GET    | `/patients?q=&acuity=&admitted=true`         | `patient:list`             | Sorted by `nameLower` | page of `Patient` (redacted) |
| C  | POST   | `/patients`                                  | `patient:create`           | `{ name, givenName?, familyName?, birthDate?, sex?, phone?, email?, address?, emergencyContact?, identifier?, bloodType?, allergies?, noKnownAllergies?, chronicConditions?, acuity?, facilityId? (system admin) }` | `201 Patient`. `409 duplicate-identifier` |
| C  | GET    | `/patients/{id}`                             | `patient:read`             | – | `Patient` |
| C  | PATCH  | `/patients/{id}`                             | `patient:update`           | Partial patient, using the per-access writable set ([3.4](#34-field-level-rules)). `careTeam`, `room` and `nextMed` are no longer accepted | `Patient` |
| N  | GET    | `/patients/{id}/care-team`                   | `patient:read`             | – | `{ data: PractitionerSummary[] }` (not paginated, at most 50). Patients get it for themselves so they can start a conversation |
| N  | POST   | `/patients/{id}/care-team`                   | `patient:manage-care-team` | `{ userId }` (active doctor or nurse) | `201 { data: PractitionerSummary[] }`. Notifies the added staff member |
| N  | DELETE | `/patients/{id}/care-team/{userId}`          | `patient:manage-care-team` (admin) | – | `204` |
| N  | POST   | `/patients/{id}/admission`                   | `patient:admit`            | `{ departmentId, ward?, room?, bed?, attendingDoctorId? }` | `201 Patient`. `409` if already admitted |
| N  | PATCH  | `/patients/{id}/admission`                   | `patient:admit`            | `{ departmentId?, ward?, room?, bed?, attendingDoctorId? }` (nurses: `ward, room, bed` only) | `Patient` |
| N  | POST   | `/patients/{id}/admission/discharge`         | `patient:admit` (doctor, admin) | `{ dischargeNote? }` | `Patient` (`admission: null`) |
| C  | GET    | `/patients/{id}/vitals?status=`              | `vitals:read`              | Sorted by `recordedAt` desc. Excludes `entered-in-error` by default | page of `VitalSigns` |
| C  | POST   | `/patients/{id}/vitals`                      | `vitals:create`            | `VitalSigns` measurements + `recordedAt?`, `notes?` | `201 VitalSigns` |
| N  | PATCH  | `/patients/{id}/vitals/{vitalsId}`           | `vitals:retract`           | `{ status: "entered-in-error", statusReason }` | `VitalSigns` |

#### Appointments

| St | Method | Path                                          | Permission           | Request / query | Response |
| -- | ------ | --------------------------------------------- | -------------------- | --------------- | -------- |
| C  | GET    | `/appointments?patientId=&doctorId=&departmentId=&status=&from=&to=` | `appointment:read` | Default scope: patient (own), doctor (own schedule), nurse (`patientId` or own department), admin (facility). Sorted by `start` asc. `upcoming=true` is replaced by `from=<now>` | page of `Appointment` |
| C  | POST   | `/appointments`                               | `appointment:create` | `{ doctorId, patientId? (staff), start, durationMinutes?, type?, reason? }` | `201 Appointment`. `409 slot-unavailable` |
| N  | GET    | `/appointments/{id}`                          | `appointment:read`   | – | `Appointment` |
| C  | PATCH  | `/appointments/{id}`                          | `appointment:update` | `{ status?, cancellationReason?, start?, durationMinutes?, type?, reason? }`. Transitions per [2.7](#27-appointment). Patients may send only `status: "cancelled"`, `cancellationReason`, `start` and `durationMinutes` | `Appointment`. `409 invalid-state-transition` |

#### Prescriptions and medication administration

| St | Method | Path                                         | Permission                          | Request / query | Response |
| -- | ------ | -------------------------------------------- | ----------------------------------- | --------------- | -------- |
| C  | GET    | `/prescriptions?patientId=&prescriberId=&status=&category=` | `prescription:read` | Patients: own. Doctors without `patientId`: `prescriberId = self`. Sorted by `createdAt` desc. Excludes `entered-in-error` unless asked | page of `Prescription` |
| C  | POST   | `/prescriptions`                             | `prescription:create`               | `{ patientId, medication, dose, route?, frequency, frequencyText?, administrationTimes?, instructions?, refills?, startDate, endDate?, category?, appointmentId? }` | `201 Prescription` |
| N  | GET    | `/prescriptions/{id}`                        | `prescription:read`                 | – | `Prescription` |
| C  | PATCH  | `/prescriptions/{id}`                        | `prescription:update`               | `{ status?, statusReason?, endDate?, refills?, instructions?, administrationTimes? }` | `Prescription` |
| N  | POST   | `/prescriptions/{id}/refill-requests`        | `prescription:request-refill`       | `{ note? }` (≤500) | `202 { status: "requested" }`. Notifies the prescriber; nothing else is stored (refill workflow **Deferred**) |
| N  | GET    | `/medication-schedule?date=&departmentId=`   | `medication-schedule:read`          | `date` defaults to today (SAST) | `{ data: ScheduledDose[], prn: Prescription[] }` (not paginated) |
| N  | GET    | `/medication-administrations?patientId=&prescriptionId=&performerId=&from=&to=` | `medication-administration:read` | At least one of `patientId`, `prescriptionId` or `performerId` (`me` allowed). Sorted by `occurredAt` desc | page of `MedicationAdministration` |
| N  | POST   | `/medication-administrations`                | `medication-administration:create`  | `{ prescriptionId, scheduledFor?, status: "completed"\|"not-done", statusReason?, occurredAt?, dose?, notes? }` | `201 MedicationAdministration`. `409 already-charted` |
| N  | PATCH  | `/medication-administrations/{id}`           | `medication-administration:retract` | `{ status: "entered-in-error", statusReason }` | `MedicationAdministration` |

#### Medical records

| St | Method | Path                                | Permission              | Request / query | Response |
| -- | ------ | ----------------------------------- | ----------------------- | --------------- | -------- |
| C  | GET    | `/medical-records?patientId=&authorId=&category=&status=` | `medical-record:read` | Patients: own, final and amended only. Doctors and nurses without `patientId`: `authorId = self`. Sorted by `effectiveAt` desc | page of `MedicalRecord` |
| C  | POST   | `/medical-records`                  | `medical-record:create` | `{ patientId, category, title, effectiveAt?, status?: "preliminary"\|"final", diagnosis?, diagnosisCode?, findings?, treatment?, recommendations?, labResults?, appointmentId? }` | `201 MedicalRecord` |
| N  | GET    | `/medical-records/{id}`             | `medical-record:read`   | – | `MedicalRecord` |
| C  | PATCH  | `/medical-records/{id}`             | `medical-record:update` | While preliminary: content fields and/or `status: "final"`. At any status: `{ status: "entered-in-error", statusReason }` | `MedicalRecord`. `409 record-immutable` |
| N  | POST   | `/medical-records/{id}/addenda`     | `medical-record:update` | `{ text }` (final or amended only) | `201 MedicalRecord` (status `amended`) |

#### Care tasks and shifts

| St | Method | Path                     | Permission         | Request / query | Response |
| -- | ------ | ------------------------ | ------------------ | --------------- | -------- |
| N  | GET    | `/care-tasks?assigneeId=&departmentId=&patientId=&status=&priority=&dueBefore=&completedBy=&completedAfter=` | `care-task:read` | `assigneeId` accepts `me` and `unassigned`; `completedBy` accepts `me`. Default for nurses: own department, `status = open,in-progress`. Sorted by `dueAt` asc (by `completedAt` desc when filtering on `completedBy`) | page of `CareTask` |
| N  | POST   | `/care-tasks`            | `care-task:create` | `{ patientId?, title, description?, category, priority?, dueAt, assigneeId?, departmentId? }` | `201 CareTask` |
| N  | GET    | `/care-tasks/{id}`       | `care-task:read`   | – | `CareTask` |
| N  | PATCH  | `/care-tasks/{id}`       | `care-task:update` | `{ status?, assigneeId?, title?, description?, priority?, dueAt?, completionNote? }` | `CareTask`. `409 invalid-state-transition` |
| N  | GET    | `/shifts?staffId=&departmentId=&from=&to=` | `shift:read` | `staffId` accepts `me`. Window at most 31 days. Sorted by `start` asc | page of `Shift` |
| N  | GET    | `/shifts/current`        | `shift:read`       | – | `{ shift: Shift \| null, previousHandover: { note, staffName, at } \| null, onDuty: { staffId, staffName, staffRole, type }[] }` (same department, not paginated) |
| N  | POST   | `/shifts`                | `shift:manage`     | `{ staffId, type, start, end, departmentId? }` | `201 Shift`. `409 conflict` on overlap |
| N  | PATCH  | `/shifts/{id}`           | `shift:manage` / `shift:handover` | Admin: `{ type?, start?, end?, departmentId?, status? }`. Owner: `{ handoverNote }` | `Shift` |

#### Notifications

| St | Method | Path                          | Permission            | Request / query | Response |
| -- | ------ | ----------------------------- | --------------------- | --------------- | -------- |
| C  | GET    | `/notifications?unread=true`  | `notification:read`   | Sorted by `createdAt` desc | page of `Notification` |
| N  | GET    | `/notifications/unread-count` | `notification:read`   | – | `{ count }` (`count()` aggregation; the header badge uses this instead of loading the list) |
| N  | PATCH  | `/notifications/{id}`         | `notification:update` | `{ read: true }` | `Notification` |
| R  | PATCH  | `/notifications/{id}/read`    | – | – | Replaced by `PATCH /notifications/{id}` |
| E  | POST   | `/notifications/read-all`     | `notification:update` | – | `{ updated }` |

#### Conversations

| St | Method | Path                                   | Permission           | Request / query | Response |
| -- | ------ | -------------------------------------- | -------------------- | --------------- | -------- |
| N  | GET    | `/conversations?type=`                 | `conversation:read`  | Participant conversations, plus channels for staff. Sorted by `lastMessageAt` desc | page of `Conversation` + `unreadCount` |
| N  | POST   | `/conversations`                       | `conversation:create` (`channel:manage` for channels) | `{ type, participantIds?, title?, patientId?, departmentId? }` | `201 Conversation` (`200` with the existing one for duplicate `direct`) |
| N  | GET    | `/conversations/{id}`                  | `conversation:read`  | – | `Conversation` |
| N  | PATCH  | `/conversations/{id}`                  | `channel:manage` (channels) / participant (groups: `title` only) | `{ title?, status? }` | `Conversation` |
| N  | GET    | `/conversations/{id}/messages`         | `conversation:read`  | Sorted by `createdAt` desc | page of `Message` |
| N  | POST   | `/conversations/{id}/messages`         | `message:create`     | `{ text }` | `201 Message`. Updates `lastMessage`, `lastMessageAt` and the sender's `lastReadAt` |
| N  | POST   | `/conversations/{id}/read`             | `conversation:read`  | – | `204`. Sets `lastReadAt[caller] = now` |

#### System settings and alerts

| St | Method | Path                    | Permission               | Request | Response |
| -- | ------ | ----------------------- | ------------------------ | ------- | -------- |
| N  | GET    | `/system-settings`      | `system-settings:read`   | – | `SystemSettings` (with defaults filled in) |
| N  | PATCH  | `/system-settings`      | `system-settings:update` | Partial (deep-merged) | `SystemSettings` |
| N  | GET    | `/system-alerts?status=&severity=` | `system-alert:read` | Sorted by `createdAt` desc | page of `SystemAlert` |
| N  | POST   | `/system-alerts`        | `system-alert:manage`    | `{ title, message, severity, facilityId? }` | `201 SystemAlert` (`source: "manual"`) |
| N  | PATCH  | `/system-alerts/{id}`   | `system-alert:manage`    | `{ status: "resolved" }` | `SystemAlert` |

### 4.3 Breaking changes against the current API

1. Every route moves from `/api/*` to `/api/v1/*`, except `/api/health`.
2. Error body: `{ message, details }` becomes RFC 9457 problem+json (`detail`, `code`, `errors[]`).
3. List envelope: `{ appointments: [...] }`, `{ patients: [...] }` and the other named arrays become
   `{ data, nextCursor }`. The default `limit` changes from 50 to 25.
4. Single-resource wrappers are removed. `{ patient: {...} }`, `{ appointment: {...} }`,
   `{ prescription: {...} }`, `{ medicalRecord: {...} }`, `{ notification: {...} }` and `{ vitals: {...} }`
   become the bare object. `GET /me` and `PATCH /me` keep `{ user, patient, permissions }`.
5. `POST /auth/signup` body: `fullName → name`, `phoneNumber → phone`, `nationalId → identifier`. The role
   is `doctor` or `nurse` only, so the frontend "Administrator" option is removed.
6. User: `phoneNumber → phone`, `nationalId → identifier`, `specialization → practitioner.specialization`.
7. Patient: `dateOfBirth → birthDate`, `priority → acuity`, `vitals → latestVitals`, `room → admission.room`.
   `nextMed` is removed. `careTeam` can no longer be patched (use the care team endpoints).
8. Vitals: `bloodPressure` changes from the string `"120/80"` to `{ systolic, diastolic }`. `bloodSugar`
   (mg/dL) becomes `bloodGlucose` (mmol/L).
9. Appointment: `date` + `time` + `scheduledAt` become `start` / `end` / `durationMinutes`. `notes → reason`.
   `type` becomes an enum. New statuses `checked-in` and `no-show`. `?upcoming=true` becomes `?from=`.
   Start times must be on a 15-minute boundary.
10. Prescription: `doctorId/doctorName → prescriberId/prescriberName`, `dosage → dose`,
    `notes → instructions`. `frequency` becomes an enum. New `route`, `category` and `administrationTimes`.
    Status `discontinued → stopped`. Admins can no longer patch prescriptions.
11. Medical record: `doctorId/doctorName → authorId/authorName`, `type → title` + `category`,
    `results → findings`, ordering by `effectiveAt`. Patients no longer see `preliminary` records.
12. Notifications: `PATCH /notifications/{id}/read` becomes `PATCH /notifications/{id} { read: true }`.
    Type `record → medical-record`.
13. `GET /doctors` is replaced by `GET /practitioners?role=doctor`. `GET /admin/stats` is replaced by
    `GET /dashboard`.
14. Admins lose read access to clinical resources (vitals, prescriptions, medical records) and to
    appointment `reason`.

---

## 5. Page to endpoint mapping

All routed pages are in `client/src/App.jsx`. Paths below are relative to `client/src/`. "Remove" means
delete the control or panel: it must not stay as mock data.

### 5.1 Shared shell and auth

| Component | Endpoints | Fields and behaviour |
| --------- | --------- | -------------------- |
| `auth/AuthProvider.jsx` | `GET /me`, `POST /me` on 404 | Stores `user`, `patient`, `permissions`. Exposes `can(permission)` |
| `auth/RequireRole.jsx` | from context | Uses `user.status` and `user.role` as today. Problem `code`s `account-pending` / `account-disabled` instead of status sniffing |
| `Layouts/DashboardLayout.jsx` | – | Already merged on the branch (one layout taking `role`). No data |
| `Components/Header/Header.jsx` | `GET /notifications/unread-count` | Badge count. `ProfileMenu` uses `user.name` and `user.photoUrl` |
| `Components/Header/SearchBar.jsx` | navigates only | Staff: submit navigates to the patient list page with `?q=`, which calls `GET /patients?q=`. Admin: to user management with `?q=` |
| `Components/Sidebar.jsx` | – | Add `Messages` for patients and `Team Chat` for doctors (both routes exist but are not linked). Hide items whose permission is missing |
| `api/client.js` | all | Base URL `${VITE_API_BASE_URL}/v1`. Parse problem+json into `ApiError { status, code, message, errors }`. Add a `listAll`/`paginate` helper using `nextCursor`. One function per endpoint in 4.2 |

### 5.2 Public pages

| Route | Component | Endpoints | Notes |
| ----- | --------- | --------- | ----- |
| `/` | `Pages/LandingPage.jsx` | – (Google sign-in, then `/dashboard`) | Tab-indented file, keep its style |
| `/staff-sign-up` | `Pages/StaffSignUp.jsx` | `POST /auth/signup` | Fields `name, identifier {type, value}, email, phone, role, password, licenceNumber?, specialization?`. Remove the `admin` option. On success show "awaiting approval" instead of redirecting to `/role-selection` |
| `/role-selection` | `Pages/RoleSelection.jsx` | – | **Delete** the route, the page and `Components/RoleSelection/*`. The role comes from the account, so a role picker is misleading |
| `/dashboard` | `RequireRole` | `GET /me` | Unchanged |

### 5.3 Shared role pages (`/{role}/settings|profile|notifications|team-chat`)

| Component | Endpoints | Fields and behaviour |
| --------- | --------- | -------------------- |
| `Components/Settings/Settings.jsx` | `GET`, `PATCH /me/preferences` | `notifications.{inApp,email,sms}`, `language` (en, af, zu, xh), `timeZone` (default Africa/Johannesburg, replacing the US zones), `theme`, `calendarView` (staff only), `listView`. Save button with optimistic state. Security card: "Change password" calls Firebase `sendPasswordResetEmail(user.email)` for password accounts and links to Google account settings for Google accounts. **Remove** 2FA and login history (Deferred) |
| `Components/ProfilePage/Profile.jsx` + `ProfileCard`, `ProfessionalInformationSection`, `ContactInformationSection`, `ScheduleOverview` | `GET /me` (context), `PATCH /me`, `GET /shifts?staffId=me&from=<today>&to=<+7d>`, patients: `PATCH /patients/{patient.id}` | **Replace the hardcoded "Dr. Sarah Connor".** ProfileCard: `user.name`, `user.photoUrl` (fallback `assets/default-avatar.svg`), title = role label + `practitioner.specialization`. Professional section (staff only): `practitioner.licenceBody`/`licenceNumber`, `specialization`, experience from `practisingSince`, `qualifications[]`, `officeLocation`. Contact section: `user.email`, `user.phone`, `user.emergencyContact`. ScheduleOverview (staff only): upcoming shifts (`type`, `start`–`end`, department). Patients instead see a demographics section: `patient.birthDate`, `sex`, `address`, `emergencyContact`, `identifier` (masked except the last 4 digits). "Edit Profile" opens a form posting to `PATCH /me` (and `PATCH /patients/{id}` for patients) |
| `Components/Notifications/Notifications.jsx` (+ `NotificationList`, `NotificationItem`, `FilterSortControls`, `NotificationIcon`) | `GET /notifications?unread=`, `PATCH /notifications/{id}`, `POST /notifications/read-all` | Filter calls the server with `unread=true` instead of filtering client-side. Sort newest first by default (oldest-first is client-side within loaded pages). "Load more" with `nextCursor`. Click navigates to `resource` when present. Add a "Mark all read" button |
| `Components/TeamChat/TeamChat.jsx` | `GET /conversations`, `POST /conversations`, `GET /conversations/{id}/messages`, `POST /conversations/{id}/messages`, `POST /conversations/{id}/read`, `GET /practitioners?q=` (new direct message) | Sidebar: channels (`type = channel`), direct and group conversations, and a "Patients" section (`type = patient`) for staff. Header user from `/me`. Poll messages every 15 s while open. **Remove** presence dots, phone and video buttons, emoji and attachments (Deferred) |

### 5.4 Admin (`/admin/*`)

| Route | Component | Endpoints | Fields and behaviour |
| ----- | --------- | --------- | -------------------- |
| `dashboard` | `Components/AdminDashboard/AdminDashboard.jsx` | `GET /dashboard`, `GET /shifts?from=<now>&to=<now+1m>` (on duty now), `GET /system-alerts?status=active&limit=5`, `GET /reports/summary` (charts) | StatsGrid: `counters.doctors, nurses, patients, pendingStaff, upcomingAppointments, admittedPatients`. **StaffSchedule** (replaces `MockData.staffSchedule`): `staffName`, shift `type`, "On duty" or "On leave". **SystemAlerts** (replaces `MockData.systemAlerts`): `severity` (info, warning, critical), `title`/`message`, relative `createdAt`, and a resolve button calling `PATCH /system-alerts/{id}`. **Analytics**: render "Patient demographics" (`patients.bySex`, `byAgeGroup`) and "Appointment distribution" (`appointments.byStatus`) from the report summary. **Remove** "Revenue Analytics" and "Resource Utilization". QuickActions become links: pending approvals, add patient, reports, system settings |
| `user-management` | `Components/AdminDashboard/UserManagement.jsx` | `GET /users?role=&status=&q=&cursor`, `GET /users/{id}`, `PATCH /users/{id}`, `GET /departments`, `GET /dashboard` (stat cards) | Replace `mockUsers` and `stats`. Status filter values are `active`, `pending` and `disabled` (not `inactive`). Columns: name, email, role, department (resolved from `departmentId`), status, `lastSignInAt`. Actions: approve (requires facility, department and licence), disable/enable with `statusReason`, change role, view details (drawer showing `identifier`, `emergencyContact`, `practitioner`). Stat cards: `counters.totalUsers, activeUsers, pendingStaff, disabledUsers`. **Remove** "Add New User" (admin invites are Deferred) or replace it with "Copy staff sign-up link" |
| `department-settings` | `Components/AdminDashboard/DepartmentSettings.jsx` | `GET /departments?include=stats`, `POST /departments`, `PATCH /departments/{id}`, `GET /users?role=doctor,nurse` (head picker) | Replace `mockDepartments` and `overallStats`. Card: `name`, `headName`, `stats.staff`, `bedCapacity`, `stats.admittedPatients`, `stats.occupancyRate`, `stats.appointmentsToday`, `location`. Overall cards: department count, sum of staff, average occupancy (computed client-side). **Remove** budget, equipment and the quick actions except "Assign staff" (link to user management `?departmentId=`). Archive is `PATCH status: archived` |
| `reports` | `Components/AdminDashboard/AdminReports.jsx`, replaced by the shared `ReportsPage` | `GET /reports/summary?from=&to=&departmentId=` | Route renders the shared reports page (see 5.5). **Delete** the report catalogue, templates, "recent reports" and downloads mock (stored reports are Deferred). Export is client-side CSV |
| `system-settings` | `Components/AdminDashboard/SystemSettings.jsx` | `GET`, `PATCH /system-settings`, `GET /api/health` (version) | Tabs: General (`organisationName`, `supportEmail`, `supportPhone`, `defaultTimeZone`, `defaultLanguage`, `maintenanceBanner`), Appointments (`appointments.*`), Security (`security.sessionTimeoutMinutes`). Controlled inputs, real Save and Cancel. System status card: API `version` and region only. **Remove** the backup, integrations and maintenance tabs and the fake storage and uptime numbers |

### 5.5 Doctor (`/doctor/*`)

| Route | Component | Endpoints | Fields and behaviour |
| ----- | --------- | --------- | -------------------- |
| `dashboard` | `Components/DoctorDashboard/DoctorDashboard.jsx` (+ `PatientsSection`, shared `AppointmentsTable`) | `GET /dashboard`, `GET /patients?limit=6`, `GET /appointments?from=<now>&status=pending,confirmed,checked-in&limit=10` | Stats from `counters` (no more fetching 4 lists of 100 to count client-side). PatientCard: `name`, age from `birthDate`, `sex`, `acuity`, `admission.room`. Appointments table: `patientName`, `start`, `type`, `status`. QuickActions become links (add patient, schedule appointment, new prescription, reports) |
| `patient-records` | `Components/DoctorDashboard/PatientRecords.jsx` | List: `GET /patients?q=&acuity=&cursor`. Detail: `GET /patients/{id}`, `GET /patients/{id}/vitals?limit=5`, `GET /prescriptions?patientId=&status=active`, `GET /medical-records?patientId=`, `GET /appointments?patientId=`. Actions: `POST /patients`, `PATCH /patients/{id}`, `POST /patients/{id}/vitals`, `POST /medical-records`, `POST /medical-records/{id}/addenda`, `POST /patients/{id}/care-team`, admission endpoints | Rows: `name`, age, `sex`, `acuity` badge, `admission` (ward, room, bed). Filter `acuity` (stable, moderate, high, critical) replaces the fake "active, critical, recovered". Detail panel: demographics, `phone`, `email`, `address`, `bloodType`, `allergies` (prominent), `chronicConditions`, `latestVitals`, active medications, records (with `labResults` table and `addenda`), last visit (latest `completed` appointment) and next appointment. **Remove** the trash icons (no hard deletes); doctors can set `status: inactive/deceased` in the edit form |
| `appointments` | `Pages/AppointmentsPage.jsx` (+ `Components/Appointments/*`) | `GET /appointments?from=&to=&status=&cursor`, `PATCH /appointments/{id}`, `POST /appointments`, `GET /patients?q=` (picker), `GET /practitioners/{id}/busy` | Date range sends `from`/`to` to the server instead of client filtering. Actions per status: confirm, check in, complete, no-show, cancel (with reason), reschedule. "Schedule Appointment" opens a booking form. Calendar view stays a placeholder (Deferred) |
| `prescriptions` | `Pages/Prescriptions.jsx` | `GET /prescriptions?prescriberId=me&status=&cursor`, `POST /prescriptions`, `PATCH /prescriptions/{id}`, `GET /patients?q=` (picker) | **This page is currently a copy of a nurse dashboard with mock data. Rewrite it** as the prescriber's list: `patientName`, `medication`, `dose`, `route`, `frequency`, `startDate`/`endDate`, `status`, `refills`. Filters: status. Actions: new prescription form, hold, resume, stop (with reason), edit end date, refills and instructions |
| `reports` | `Components/DoctorDashboard/ReportsPage.jsx`, moved to the shared `Components/Reports/ReportsPage.jsx` | `GET /reports/summary?from=&to=` | One role-aware component for doctor, nurse and admin. Date range select sets `from`/`to`. Sections: overview counters, `patients.bySex`, `byAgeGroup`, `topConditions`, `appointments.byStatus`/`byType`/`byDay`/`byHour`, `prescriptions.topMedications` (when not null), `departments` table (admin). **Remove** revenue, satisfaction and the "financial" report type. "Export Report" downloads CSV generated client-side |
| `team-chat`, `settings`, `notifications`, `profile` | shared | see 5.3 | |

### 5.6 Nurse (`/nurse/*`)

| Route | Component | Endpoints | Fields and behaviour |
| ----- | --------- | --------- | -------------------- |
| `dashboard` | `Components/NurseDashboard/NurseDashboard.jsx` (+ `AssignedPatientsSection`, `TodayTasksSection`, `ShiftInfoSection`, `RecentAlertsSection`, `QuickActionsSection`) | `GET /dashboard`, `GET /patients?limit=10`, `GET /care-tasks?assigneeId=me&status=open,in-progress&dueBefore=<end of today>`, `PATCH /care-tasks/{id}`, `GET /shifts/current` | **Replace all `MockData` use.** QuickStats: `counters.patientsUnderCare, tasksDueToday, medicationsDueNow, criticalPatients`. Assigned patients: `name`, `admission.room/bed`, `acuity`. Today's tasks: `title`, `patientName`, `dueAt`, `priority`. "Start" sets `in-progress` and "Done" sets `completed` (drop the local timer). ShiftInfo: `shift.type`, `start`–`end`, `previousHandover.note`/`staffName`, `onDuty` colleagues, and a handover note editor (`PATCH /shifts/{id}`). RecentAlerts: `alerts[]` (`message`, `at`). Quick actions become links: record vitals and update notes (My Patients), administer medication (Medications), tasks. **Remove** "Request Doctor" and "Emergency Alert" (Deferred) |
| `my-patients` | `Components/NurseDashboard/MyPatients.jsx` | `GET /patients?q=&acuity=&cursor`, `POST /patients/{id}/vitals`, `POST /medical-records` (`category: nursing-note`), `GET /care-tasks?patientId=`, `PATCH /patients/{id}/admission` (room or bed) | Cards: `name`, `admission.room/bed`, `latestVitals` (temperature in °C, BP `systolic/diastolic`, HR), `acuity`, `allergies`. Search uses `q` server-side. "Upcoming tasks" panel: the nurse's open tasks. **Remove** "recent updates" (activity feed Deferred), `lastMedication` and `nextCheck` |
| `tasks` | `Components/NurseDashboard/Tasks.jsx` | `GET /care-tasks?status=open,in-progress&priority=&dueBefore=&cursor`, `GET /care-tasks?completedBy=me&completedAfter=<start of today>`, `POST /care-tasks`, `PATCH /care-tasks/{id}` | Summary cards are counts by `priority` (low, normal, high, urgent) computed from the loaded page, plus a completed-today count. Timeframe "today" or "tomorrow" sets `dueBefore`. Grouped by priority. "Today's schedule" groups `dueAt` by hour client-side. Actions: create, claim, start, complete with note, cancel |
| `medications` | `Components/NurseDashboard/Medications.jsx` | `GET /medication-schedule?date=`, `POST /medication-administrations`, `GET /medication-administrations?performerId=me&limit=10`, `PATCH /medication-administrations/{id}` (entered in error) | Summary: counts of `due`, `upcoming`, `given`/`not-given`, total. Period tabs (morning 06–12, afternoon 12–18, evening 18–24, night 00–06) group `scheduledFor` client-side. Row: `patientName`, `room`, `medication`, `dose`, `route`, `instructions`, `status`. Buttons: "Given" and "Not given" (reason). Allergy warning when `allergies` is not empty. Recent administrations list. Date select: today or tomorrow (the "week" option is removed). **Remove** the drug interaction alerts (Deferred) |
| `reports` | shared `ReportsPage` | `GET /reports/summary` | Nurse scope (department) |
| `team-chat`, `settings`, `notifications`, `profile` | shared | see 5.3 | |

### 5.7 Patient (`/patient/*`)

| Route | Component | Endpoints | Fields and behaviour |
| ----- | --------- | --------- | -------------------- |
| `dashboard` | `Components/PatientDashboard/PatientDashboard.jsx` (+ `AppointmentCard`, `PrescriptionsCard`, `NotificationCard`) | `GET /me` (context: `patient.latestVitals`), `GET /appointments?from=<now>&limit=5`, `GET /prescriptions?status=active`, `GET /notifications?unread=true&limit=5` | Health stats: `latestVitals.bloodPressure` (formatted `systolic/diastolic mmHg`), `heartRate`, `weight`, `bloodGlucose` (mmol/L). AppointmentCard: `type`, `start` (formatted in SAST), `doctorName`, `status`. Quick actions become links: book appointment, prescriptions (refill), medical records, messages |
| `appointments` | `Components/PatientDashboard/UpcomingAppointmentsCard.jsx` (grows into the patient appointments page) | `GET /appointments?from=<now>` (upcoming tab), `GET /appointments?to=<now>` (past tab), `POST /appointments`, `PATCH /appointments/{id}`, `GET /practitioners?role=doctor`, `GET /practitioners/{id}/busy` | Booking form: doctor, date, free 15-minute slots computed from `busy` and the settings, `durationMinutes`, `type`, `reason`. Cancel (with reason) and reschedule while `pending` or `confirmed` |
| `prescriptions` | `Components/PatientDashboard/PatientPrescriptions.jsx` | `GET /prescriptions?status=active`, `GET /prescriptions?status=completed,stopped` (history), `POST /prescriptions/{id}/refill-requests` | Fields: `medication`, `dose`, `frequency`, `instructions`, `startDate`/`endDate`, `refills`, `prescriberName`. "Request refill" is shown for current outpatient prescriptions with `refills > 0` |
| `medical-records` | `Components/PatientDashboard/MedicalRecords.jsx` | `GET /me` (patient), `GET /patients/{id}/vitals?limit=2` (trend arrows from the previous reading), `GET /prescriptions?status=active`, `GET /appointments?to=<now>&status=completed` (visits), `GET /medical-records?category=&cursor` | Header: `name`, `birthDate`, `bloodType`, `allergies`, `chronicConditions` (replacing "ID: {patient.id}"). Vitals cards with the real trend. Tabs: summary, records (`title`, `category`, `effectiveAt`, `authorName`, `labResults` table, `addenda`), visits, medications. **Remove** "Add Note" and "Order Lab" (staff actions) |
| `messages` | `Components/PatientDashboard/Messages.jsx` | `GET /conversations?type=patient`, `POST /conversations` (`type: patient`), `GET /patients/{id}/care-team` (recipient picker), conversation message endpoints | **Rewrite**: it is currently a staff-side "Patient Messages" mock. The patient sees their conversations with their care team: `title`/participants, `lastMessage`, `unreadCount`, and a thread with a composer. **Remove** stats, quick responses and attachments (Deferred). The staff side of these conversations lives in TeamChat's "Patients" section |
| `settings`, `notifications`, `profile` | shared | see 5.3 | |

### 5.8 Dead code to delete

Frontend commit `e935c67` ("Remove dead code from the client") already removed these unrouted or unused
files:

- `Pages/AdminDashboard.jsx`, `Pages/MedicalRecords.jsx`, `Pages/PatientRecords.jsx`,
  `Pages/NotificationsPage.jsx`
- `Components/MedicalRecords/*` and `Components/AdminDashboard/ReportsPage.jsx`
- `Components/PatientDashboard/HealthStatsGrid.jsx`, `PatientNotifications.jsx`, `WelcomeHeader.jsx`,
  `QuickActionCard.jsx`
- `Auth.js`, `Components/GoogleAuth/Auth.js`, `Components/GoogleAuth/firebaseConfig.js`,
  `Components/mostUsedPrompts.txt` and unused assets

Commit `3715870` replaced the four role layouts with `DashboardLayout`. Commit `7700e20` merged the two
appointment tables and removed the per-dashboard stat and quick-action components.

Still to delete in this iteration:

| File(s) | Reason |
| ------- | ------ |
| `Pages/RoleSelection.jsx`, `Components/RoleSelection/RoleCard.jsx`, `ContinueButton.jsx`, and the `/role-selection` route in `App.jsx` | Fake role picker. The role comes from the account. StaffSignUp should stop redirecting there |
| `Components/AdminDashboard/AdminReports.jsx`, `Components/DoctorDashboard/ReportsPage.jsx` | Replaced by one shared `Components/Reports/ReportsPage.jsx` (see 5.4 and 5.5) |
| `data/MockData.js`, `assets/pics/*` | Delete once the last importer (TeamChat, NurseDashboard and any others) is migrated. `pics` are only imported by `MockData` |
| Any page-local `mock*` constants | Every routed page must read from the API per this section, or remove the panel |

### 5.9 Shared UI components (reuse targets)

`Components/common/` already contains `AsyncContent`, `Button`, `Card`, `InitialsAvatar`, `PageShell`,
`QuickActions`, `StatCard`, `StatusBadge` and `TableHead`, plus `utils/status.js`. Pages rewritten in this
iteration must use them instead of re-inlining the patterns:

- `Card` for every white bordered section with a title.
- `StatCard` for every label + value + icon tile. Use explicit labels, not
  `key.replace(/([A-Z])/g, " $1")`.
- `StatusBadge` + `utils/status.js` for every enum value in section 2: appointment, prescription, record,
  task, user status, `acuity`, alert severity and scheduled dose status. Add the new enum values (for
  example `checked-in`, `no-show`, `on-hold`, `stopped`, `entered-in-error`, `in-progress`, `overdue`)
  there, not as ternary chains in pages.
- `InitialsAvatar` wherever a photo may be missing.
- `PageShell` (header + actions) for every page. It replaces the `flex h-screen … <></>` wrappers.
- `TableHead` (+ a shared row style) for the user, prescription, task and patient tables.
- `QuickActions` with `{ label, icon, to }` links on all four dashboards.
- Still missing and worth adding: `FilterSelect`, `EmptyState`, `LoadMore` (cursor pagination, used by
  every paginated list) and `Modal` (patient detail, booking, prescription and task forms). Add the
  formatting helpers `formatDateTime(iso)` (SAST), `formatBloodPressure({ systolic, diastolic })` and
  `labelFor(enumValue)` to `utils/format.js`.

---

## 6. Data migration

Script: `scripts/migrate-v1.js`.

- **Idempotent.** Documents with `schemaVersion >= 2` are skipped. Each transform is a pure function
  `(doc) => update | null`, unit-tested.
- **Dry run by default.** It prints counts per collection plus up to 5 sample diffs with IDs only and no
  PHI values. `--apply` writes. Writes use batches of at most 400.
- **Targets.** It refuses to run unless `FIRESTORE_EMULATOR_HOST` is set, or `--project <id> --confirm
  <id>` is passed with matching values. **Agents only run it against the emulator.** The production run is
  done by the owner.
- Removed or renamed source fields are copied to `legacy.<field>` before deletion (`FieldValue.delete()`).
  Every migrated document gets `schemaVersion: 2`. `updatedAt` and `updatedBy` are set to `"system"` if
  missing.

| Collection | Transform |
| ---------- | --------- |
| `facilities` (new) | If none exist, create `facilities/default` `{ name: "CureCloud Demo Hospital", type: "hospital", status: "active" }`. Override with `--default-facility-name` |
| `users` | `phoneNumber → phone` (normalized E.164). `nationalId → identifier` (`za-id` if 13 digits passing Luhn, otherwise `other`). `specialization → practitioner.specialization` for doctors and nurses (and `practitioner.licenceBody` from role). Staff with `facilityId: null` get `default`. Add `departmentId: null`, `nameLower`, `updatedAt`/`updatedBy`/`createdBy` (`createdBy` = own UID). Admins keep `facilityId: null` (system admins) |
| `patients` | `dateOfBirth → birthDate`. `priority → acuity`. `vitals → latestVitals` (with the vitals transform below). `room` → if non-null, `admission: { departmentId: null, departmentName: "Unassigned", room, admittedAt: createdAt, admittedBy: "system" }`, otherwise `admission: null`. `nextMed → legacy.nextMed`. Add `status: "active"`, `sex: "unknown"`, `allergies: []`, `noKnownAllergies: false`, `chronicConditions: []`, `conditionCategories: []`, `identifier: null`, `facilityId` (`default` if the care team is non-empty, else `null`), `nameLower`, and `phone`/`email` copied from the linked user |
| `patients/*/vitals` | `bloodPressure "120/80"` → `{ systolic: 120, diastolic: 80 }`. `bloodSugar` (mg/dL) → `bloodGlucose = round(bloodSugar / 18, 1)` mmol/L, original kept in `legacy.bloodSugar`. Add `status: "final"`, `createdBy = recordedBy`, `createdByName` (looked up), `patientId` |
| `appointments` | `scheduledAt → start`. `end = start + 30 min`, `durationMinutes: 30`. `date`, `time → legacy`. `notes → reason`. `type` map: "General Checkup" → `check-up`, "Follow-up" → `follow-up`, "Consultation" → `consultation`, anything else → `other` (original in `legacy.type`). Add `facilityId`/`departmentId` from the doctor (`default` facility fallback) and `updatedBy`. Statuses are unchanged |
| `appointmentSlots` | Add `{ doctorId, start }` fields to existing locks. For active appointments, `create()` the second 15-minute lock (`start + 15 min`) if missing. Grandfathered appointments not on a 15-minute boundary keep their single legacy lock |
| `prescriptions` | `doctorId/doctorName → prescriberId/prescriberName`. `dosage → dose`. `notes → instructions`. `frequency` map: "Once daily" → `once-daily`, "Twice daily" → `twice-daily`, "Three times daily" → `three-times-daily`, "Four times daily" → `four-times-daily`, "As needed" → `as-needed`, "At night" → `at-night`, anything else → `custom` with `frequencyText` = the original and `administrationTimes: ["08:00"]`. Add `route: "oral"`, `category: "outpatient"`, `administrationTimes` (defaults per frequency). Status `discontinued → stopped` |
| `medicalRecords` | `doctorId/doctorName → authorId/authorName`, add `authorRole: "doctor"`. `type → title`, plus `category` by keyword: "blood", "lab", "test" → `lab-result`; "x-ray", "scan", "mri", "ct" → `imaging`; otherwise `consultation`. `results → findings`. Add `effectiveAt = createdAt`, `labResults: []`, `addenda: []` |
| `notifications` | `type: "record" → "medical-record"`. Add `readAt` (`updatedAt` or `null`), `resource: null`, `expiresAt = createdAt + 90 days` |
| `systemSettings`, `userPreferences`, `systemAlerts`, `departments`, `careTasks`, `shifts`, `medicationAdministrations`, `conversations` | New and empty. No migration (defaults are applied on read) |

Deploy order (owner): deploy the new indexes first and wait until they are built. Then run the migration
dry run, then `--apply`, then deploy the functions and Hosting together. The old `scheduledAt` and
`doctorId` indexes are removed in a follow-up deploy. `scripts/seed.js` is rewritten to produce v2-shaped
demo data directly.

---

## 7. Deferred

Explicitly out of scope for this iteration. The UI hides or removes these controls.

- Realtime chat. Plan for later: Firestore security rules that allow
  `read: if request.auth.uid in get(/databases/$(database)/documents/conversations/$(cid)).data.participantIds`
  on `messages`, with client `onSnapshot`. Writes stay on the API. Also deferred: presence, typing
  indicators, attachments, reactions, message edit and delete, quick-response templates.
- Email and SMS delivery of notifications. Appointment reminder jobs (Cloud Scheduler).
- The Firestore TTL policy on `notifications.expiresAt`. This is a one-off ops step:
  `gcloud firestore fields ttls update expiresAt --collection-group=notifications`.
- Admin-created staff invites (`POST /users`), MFA, login history, a per-read access audit log, and
  break-glass emergency access.
- A coded drug catalogue (SAMF / NAPPI), drug interaction checks, a refill approval workflow, and automatic
  prescription completion.
- Lab orders ("Order Lab"), imaging attachments, and file storage.
- Admission history read API and bed and ward management beyond free-text ward, room and bed.
- Doctor availability templates and recurring rotas. Calendar views.
- Stored or scheduled report generation and downloads. Financial, budget, equipment, satisfaction and
  revenue metrics.
- Merging a self-registered patient with a walk-in record, and an activity feed or patient timeline.
- UI translations for af, zu and xh (the preference is stored only).
- Rate limiting.

---

## 8. Implementation notes

Backend layout:

- `src/lib/policy.js` (section 3) and `src/lib/problem.js` (`HttpProblem` + error handler).
- `src/lib/pagination.js` (cursor encode, decode, page) and `src/lib/dates.js` (SAST helpers, slot
  alignment).
- `src/schemas/*.js`: zod entity, request and response schemas, registered in an OpenAPI registry.
- `src/routes/v1/*.js`: one router per resource. `src/openapi.js` builds the document.

Writes that touch more than one document use transactions or batches: booking with slots and care team,
vitals with `latestVitals`, discharge with history, a message with the conversation summary, and an
administration with its deterministic ID. Notifications are written inside the same transaction or batch,
as `notify()` does today.

Tests:

- `test/policy.test.js`: pure unit tests of the matrix, the relationship rules and redaction.
- Integration tests per resource against the emulators, including at least one test per denial type in
  [3.5](#35-denial-semantics) and per state machine.
- An OpenAPI coverage test.

Frontend:

- `api/client.js` is updated first, with one function per endpoint.
- Pages are migrated section by section following [5](#5-page-to-endpoint-mapping). Shared components
  ([5.9](#59-shared-ui-components-reuse-targets)) are extracted as they are touched.
- `MockData.js` is deleted last.
