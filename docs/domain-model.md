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
  | `administrationSlots`       | `{prescriptionId}_{epochMillis}` (scheduled doses only) | A scheduled dose has at most one live (not `entered-in-error`) administration |
  | `userPreferences`           | `{uid}`                                     | One preferences document per user            |
  | `patientIdentifiers`        | `hmacSha256(key, "{type}:{value}")` hex     | One patient per national ID or passport      |
  | `conversations` (direct)    | `direct_{uidA}_{uidB}` (UIDs sorted)        | One direct conversation per pair of users    |

  `patientIdentifiers` uses a keyed hash so that identity numbers never show up in document paths or logs.
  A plain `sha256` would not be enough: a 13-digit SA ID has a small search space (a valid date, a sequence
  number and a Luhn check digit), so an unkeyed hash can be reversed by brute force. The key is the secret
  `PATIENT_IDENTIFIER_KEY` (`defineSecret`); the emulator and tests use the fixed demo key
  `demo-identifier-key`. Rotating the key requires rehashing every `patientIdentifiers` document (a
  migration step, not an API operation). Each document is `{ patientId }` plus audit fields.

  `administrationSlots` mirrors `appointmentSlots`: it is a lock document `{ prescriptionId, scheduledFor,
  administrationId }`, and the administrations themselves always have auto IDs. Marking an administration
  `entered-in-error` deletes its lock in the same transaction, so the dose can be charted again
  ([2.9](#29-medicationadministration)).

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

Every stored document has these fields, except append-only `auditEvents` (which has `at` and `actorId`
instead). The server sets them and ignores them in request bodies.

| Field           | Type             | Notes                                                          |
| --------------- | ---------------- | -------------------------------------------------------------- |
| `createdAt`     | timestamp        | Server time on create                                          |
| `createdBy`     | string           | User ID, or `"system"` for server-generated documents          |
| `updatedAt`     | timestamp        | Server time on every write (equals `createdAt` on create)      |
| `updatedBy`     | string           | User ID or `"system"`                                          |
| `schemaVersion` | integer          | `2` for every document written by v1 code. Not serialized      |

Subcollection documents and embedded objects do not repeat audit fields unless their entity says so.

These fields record only the first and the last writer. The change history lives in the append-only
`auditEvents` collection ([2.20](#220-auditevent)), which every clinical, patient, care team and
account-control write appends to in the same batch or transaction.

Denormalized display names (`patientName`, `doctorName`, `authorName` and so on) are **snapshots taken at
write time**. They are not rewritten when someone is renamed. They exist so list views do not need extra
reads.

### 1.4 Clinical data retention (never hard-delete)

- Clinical records are **never hard-deleted** through the API: patients, vitals, prescriptions, medication
  administrations, medical records, appointments, admissions and messages. There are no `DELETE` endpoints
  for them.
- How each one is corrected:

  | Entity | Correction |
  | ------ | ---------- |
  | VitalSigns, Prescription, MedicationAdministration, MedicalRecord | Status transition to `entered-in-error`, which requires a `statusReason`. The document stays in place and is excluded from default list results. Staff with clinical access can still list it with `?status=entered-in-error` |
  | MedicalRecord (`final` or `amended`) | Immutable. Corrections are appended as **addenda** ([2.11](#211-medicalrecord)), or the whole record is set to `entered-in-error` |
  | Appointment | Cancelled (`status: "cancelled"` with `cancellationReason`). A wrongly recorded outcome is not editable in v1 |
  | Patient | Demographic fields are corrected in place with `PATCH` (each change is in `auditEvents`). The record is deactivated (`status: "inactive"` or `"deceased"`), never removed |
  | Admission | Corrected in place with `PATCH /patients/{id}/admission`, or closed by discharge, which moves it to the history subcollection |
  | Message | Append-only. Not correctable in v1 (edit and delete are **Deferred**) |
  | AuditEvent | Append-only. Never updated or deleted by the API |

- Non-clinical configuration (facilities, departments, channels) is archived with `status: "archived"`.
- Only relationship rows and ephemera are hard-deleted: care team membership
  (`DELETE /patients/{id}/care-team/{userId}`), appointment slot locks (released on cancel or reschedule),
  administration slot locks (released when the administration is set to `entered-in-error`), and
  notifications (Firestore TTL on `expiresAt`, 90 days; the TTL policy is an ops step, see
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
- The cursor is base64url of the JSON array `[...orderByValues, docId]`: the last returned document's values
  for the list's `orderBy` fields (timestamps as ISO strings, re-typed on decode) followed by its document
  ID. The server calls `startAfter(...values, docId)` on the same scoped query, so a cursor never loads a
  document and needs no extra read. It cannot reach another collection or a resource the caller cannot see,
  because the query it is applied to is already scoped. The server fetches `limit + 1` documents to decide
  whether `nextCursor` is set. A cursor that does not decode, or whose length or value types do not match
  the list's sort order, returns `400 invalid-cursor`.
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
| `invalid-cursor`           | 400    | Pagination cursor cannot be decoded or does not match the list's sort order  |
| `unauthenticated`          | 401    | Missing, invalid or expired bearer token                                     |
| `profile-required`         | 403    | Signed in but no `users` document (call `POST /me`)                          |
| `account-pending`          | 403    | Staff account awaiting approval                                              |
| `account-disabled`         | 403    | Account disabled                                                             |
| `forbidden`                | 403    | Role lacks the permission, or a field-level rule denies the write            |
| `not-found`                | 404    | Resource missing **or not visible to the caller** (see [3.5](#35-denial-semantics)) |
| `conflict`                 | 409    | Generic uniqueness conflict (profile exists, email exists)                   |
| `slot-unavailable`         | 409    | Appointment slot already booked, or outside opening hours or the doctor's leave |
| `invalid-state-transition` | 409    | Status change not allowed from the current status                            |
| `record-immutable`         | 409    | Edit attempted on a final medical record or a terminal resource              |
| `duplicate-identifier`     | 409    | Another patient already has this national ID or passport (staff-only disclosure, see [3.4](#34-field-level-rules)) |
| `already-charted`          | 409    | Scheduled dose already has a live administration (retract it first)          |
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
- `GET /api/openapi.json` serves the spec (also committed as `docs/openapi.json` by `npm run openapi`). `GET
  /api/docs` serves Swagger UI (`swagger-ui-dist`). Both are public (they contain no data or secrets) and
  cacheable; data routes stay `Cache-Control: no-store`.
- Every route registers its path, its `x-permission` (the permission string from section 3), its
  parameters, its request body, its responses and its problem types. Security scheme: `bearerAuth` (HTTP
  bearer, Firebase ID token).
- The README endpoint table is deleted and replaced with a link to `/api/docs` and to this document.
- Routes are registered through one helper, `defineRoute(router, { method, path, permission, request,
  responses })` in `src/lib/route.js`. It mounts the Express handler (with `requirePermission` and zod
  validation) and registers the same path in the OpenAPI registry, and it records each call in a route
  list. Express 5 does not expose its route table, so the coverage test compares that list with the spec's
  paths and operations, and also validates the spec.

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

Rules: never log request or response bodies. Application logs record IDs, route templates, status codes and
the caller UID only. PHI is never put in notification text beyond what the recipient can already see. PHI is
never put in `detail` messages.

Accepted risk: Cloud Run request logs (which back the function) record full URLs, including query strings.
The only query parameter that carries personal information is the name prefix `q` on `GET /patients` and
`GET /users`/`GET /practitioners` (a few letters of a name, never an ID number, which is not searchable).
v1 accepts this: those logs are in the same project, readable only by project owners, with the default
30-day retention. Moving search to a `POST …/search` body is the fallback if this is ever judged
insufficient. No other query parameter may carry PII or PHI; IDs, enums and instants only.

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
| `phone`            | string                                             |     | PII      | E.164 (renamed from `phoneNumber`). Staff and admins only, see "Contact data" below |
| `photoUrl`         | string (URL)                                       |     | internal | From the Google profile |
| `role`             | `"patient" \| "nurse" \| "doctor" \| "admin"`      | ✓   | internal | |
| `status`           | `"pending" \| "active" \| "disabled"`              | ✓   | internal | Patients start `active`; staff start `pending` |
| `statusReason`     | string ≤200                                        |     | internal | Set when disabling or rejecting |
| `facilityId`       | string                                             |     | internal | Required to activate staff. `null` on an admin means **system admin** |
| `departmentId`     | string                                             |     | internal | Required for nurses before activation; optional for doctors. Always an active department of the user's own `facilityId` (see invariants) |
| `identifier`       | Identifier                                         |     | PII-high | Staff only (from signup). Replaces `nationalId` |
| `emergencyContact` | EmergencyContact                                   |     | PII      | Staff and admins only, see "Contact data" below |
| `practitioner`     | Practitioner                                       |     | internal | Present iff `role` is `doctor` or `nurse` |
| `lastSignInAt`     | timestamp                                          |     | internal | **Not stored.** Read from Firebase Auth metadata on admin list and detail reads |
| `emailVerified`    | boolean                                            |     | internal | **Not stored.** Read from the Firebase Auth record on admin list and detail reads, like `lastSignInAt` |

Status transitions: `pending → active` (approve), `pending → disabled` (reject, `statusReason` required),
`active ↔ disabled`. Changing status keeps Firebase Auth `disabled` in sync, and disabling also calls
`revokeRefreshTokens`.

`pending → active` also requires the Firebase Auth record's `emailVerified === true`, read with
`getUser(uid)` inside the request (`409 invalid-state-transition` otherwise). `POST /auth/signup` accepts any
email address, so without this an admin could approve an impostor who signed up with a real clinician's
work address. Google accounts are always verified. Password accounts are verified through Firebase's own
`sendEmailVerification` email, which StaffSignUp sends right after signup ([5.2](#52-public-pages)), so no
app email infrastructure is needed.

Invariants (all enforced by `PATCH /users/{id}`; a violation returns `403 forbidden` unless stated):

- Patients cannot become staff and staff cannot become patients (`400 validation-error`).
- **Nobody may change their own `role`, `status`, `facilityId` or `departmentId`.** `PATCH /users/{ownId}`
  with any of them returns `403`. Self-service edits go through `PATCH /me`, which does not accept them.
- **Only a system admin may**:
  - grant or revoke `role: "admin"`;
  - set, change or clear `facilityId` on an admin account (clearing it creates a system admin);
  - modify any admin account in any way;
  - modify a patient account (`role: "patient"`), for example to disable it.
- **A facility admin may only manage doctors and nurses** that are either in their facility, or `pending`
  with `facilityId: null` (self-signups awaiting assignment). When a facility admin sets `facilityId`, it must
  be their own facility. A facility admin cannot move staff out of their facility (only a system admin can).
- **Department and facility stay consistent** (`400 validation-error` otherwise). A non-null `departmentId`
  must reference an `active` department whose `facilityId` equals the target's resulting `facilityId`, so
  a facility admin can never assign a department of another facility. Any change to `facilityId` must set
  `departmentId` (to a department of the new facility) or clear it (`null`) in the same request, so a move
  never leaves a stale department behind. A user with `facilityId: null` has `departmentId: null`. The
  `ward` and `department` rules ([3.3](#33-relationship-and-attribute-rules)) compare only department IDs
  and rely on this invariant.
- **The last active system admin** cannot be demoted, disabled, or given a non-null `facilityId`
  (`409 conflict`).
- Role changes between `doctor` and `nurse` re-derive `practitioner.licenceBody` and require a new
  `practitioner.licenceNumber` in the same request (licence numbers are body-specific). Promotion of a
  doctor or nurse to `admin` moves `practitioner` to `legacy.practitioner`; demotion from admin to doctor or
  nurse creates a new `practitioner` and requires `licenceNumber` (and `departmentId` for nurses).
- Every change to `role`, `status`, `facilityId` or `departmentId` appends an `auditEvents` entry
  ([2.20](#220-auditevent)) in the same transaction.

Contact data: for `role: "patient"` the linked Patient document is the **single source of truth** for
`phone`, `emergencyContact` and contact `email`. The patient's `users` document stores neither `phone` nor
`emergencyContact` (the migration moves them, see [6](#6-data-migration)), and `PATCH /me` rejects those
fields for patients with `403 forbidden` naming the field. `User.email` is always the **sign-in email** from
Firebase Auth and is never edited through the API; `Patient.email` is a separate contact email that the
patient or staff may change. For staff and admins, `User.phone` and `User.emergencyContact` are the source.

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

`PractitionerSummary` is the directory projection: `{ id, name, role, email, specialization, photoUrl,
facilityId, facilityName, departmentId, departmentName }`. Facility and department names are resolved per
request with `getAll`. `email` is the work (sign-in) email; it is redacted (omitted) for patient callers.

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

Facilities are read-only through the API in v1 (`GET /facilities`). They are created by the migration
(`facilities/default` if no facility exists yet, see [6](#6-data-migration)) and by `scripts/seed.js`.
Facility management endpoints are **Deferred**.

### 2.4 Department

Collection `departments/{id}`. A top-level collection with `facilityId`, which keeps queries simple. A
department doubles as the ward used for nurse scoping.

| Field         | Type                     | Req | Class    | Notes |
| ------------- | ------------------------ | --- | -------- | ----- |
| `facilityId`  | string                   | ✓   | public   | Set on create and **immutable** afterwards. On `POST` it must pass `facility` for the caller (facility admins: their own facility; system admins: any active facility, required in the body) |
| `name`        | string 2–120             | ✓   | public   | Unique per facility (case-insensitive) |
| `headId`      | string                   |     | internal | Active doctor or nurse in the same facility |
| `headName`    | string                   |     | internal | Snapshot |
| `location`    | string ≤200              |     | public   | |
| `phone`       | string                   |     | public   | |
| `bedCapacity` | integer ≥0               | ✓   | public   | 0 means an outpatient department |
| `status`      | `"active" \| "archived"` | ✓   | public   | |

Because `facilityId` never changes, moving a department to another facility (which would move every
nurse's `ward` access with it) is impossible; a new department is created instead and staff are reassigned
through `PATCH /users/{id}`.

`DepartmentStats` is computed when `?include=stats` is passed, admins only: `{ staff, doctors, nurses,
admittedPatients, occupancyRate (0–1 or null when bedCapacity = 0), appointmentsToday }`. It uses `count()`
aggregations.

### 2.5 Patient

Collection `patients/{id}`. Demographics, clinical summary and current admission.

| Field               | Type                                                         | Req | Class    | Notes |
| ------------------- | ------------------------------------------------------------ | --- | -------- | ----- |
| `id`                | string                                                       | ✓   | internal | |
| `userId`            | string                                                       |     | internal | Linked account, `null` for walk-ins |
| `facilityId`        | string                                                       |     | internal | Registering facility. `null` for a self-registered patient until their first booking sets it to the doctor's facility. After that only a system admin may change it |
| `folderNumber`      | string `^[A-Za-z0-9/-]{1,30}$`                               |     | PII      | Hospital folder number (MRN) issued by the facility. Shown in the UI instead of the opaque `id`. Not unique-enforced in v1 |
| `status`            | `"active" \| "inactive" \| "deceased"`                       | ✓   | PII      | Default `active`. Administrative (record status), see the note below |
| `deceasedAt`        | date                                                         |     | PII      | Required iff `status = deceased`. Administrative, like a date of death on a register |
| `name`              | string                                                       | ✓   | PII      | |
| `givenName`         | string ≤60                                                   |     | PII      | |
| `familyName`        | string ≤60                                                   |     | PII      | |
| `birthDate`         | date                                                         |     | PII      | Renamed from `dateOfBirth` |
| `sex`               | `"female" \| "male" \| "intersex" \| "unknown"`              | ✓   | PII      | Administrative sex as on ID documents. Default `unknown` |
| `phone`             | string                                                       |     | PII      | |
| `email`             | string                                                       |     | PII      | Contact email. Not the sign-in email (that is `User.email`) |
| `address`           | Address                                                      |     | PII      | |
| `emergencyContact`  | EmergencyContact                                             |     | PII      | |
| `identifier`        | Identifier                                                   |     | PII-high | Readable only by self and admin ([3.4](#34-field-level-rules)). Set only by staff on `POST /patients` and edited only by administrative access; patients see it read-only (masked). Unique through `patientIdentifiers` |
| `bloodType`         | `"A+" \| "A-" \| "B+" \| "B-" \| "AB+" \| "AB-" \| "O+" \| "O-"` |  | PHI      | |
| `allergies`         | `Allergy[]` ≤50                                              | ✓   | PHI      | Default `[]` |
| `noKnownAllergies`  | boolean                                                      | ✓   | PHI      | `true` only when `allergies` is empty. It separates "no known allergies" from "not yet recorded" |
| `chronicConditions` | `Condition[]` ≤50                                            | ✓   | PHI      | Default `[]` |
| `acuity`            | `"stable" \| "moderate" \| "high" \| "critical"`             | ✓   | PHI      | Renamed from `priority`. Default `stable`. Self and clinical only |
| `admission`         | Admission                                                    |     | PII      | Current inpatient stay, or `null`. Classed PII (a person's location), not PHI: admins see it for bed management ([3.4](#34-field-level-rules)). It holds no diagnosis, only department and bed |
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

Classification note: `status`, `deceasedAt` and `sex` are administrative register fields (as on an ID
document or a hospital's patient index), so they are classed PII like `admission`, and administrative access
sees them. Health information about the patient (allergies, conditions, vitals, acuity, blood type) stays
PHI.

Stored but not serialized: `nameLower` (search), `admitted: boolean` (`admission != null`, written in the
same update as `admission`; Firestore cannot filter on "field is not null" while sorting by `nameLower`, so
`?admitted=` and the admitted counters use it), `conditionCategories: string[]` (the 3-character ICD-10
prefixes of `chronicConditions[].code`, used by reports) and `legacy`.

Admission department: on `POST` and `PATCH /patients/{id}/admission`, `departmentId` must reference an
`active` department whose `facilityId` equals `patient.facilityId` (`400 validation-error` otherwise). If
`patient.facilityId` is `null` (a self-registered patient who has never booked), the department must be in
the caller's facility (system admins: any facility) and the admission sets `patient.facilityId` to the
department's facility in the same write, as booking does.

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
| `start`              | timestamp                                         | ✓   | PII      | Aligned to a 15-minute boundary (SAST). Replaces `date` + `time` + `scheduledAt` |
| `end`                | timestamp                                         | ✓   | PII      | `start + durationMinutes` |
| `durationMinutes`    | `15 \| 30 \| 45 \| 60`                            | ✓   | PII      | Default from system settings (30) |
| `type`               | `"check-up" \| "consultation" \| "follow-up" \| "procedure" \| "test" \| "vaccination" \| "other"` | ✓ | PII | Default `check-up` |
| `reason`             | string ≤1000                                      |     | PHI      | Reason for the visit. Replaces `notes`. Self and clinical only ([3.4](#34-field-level-rules)) |
| `status`             | see lifecycle                                     | ✓   | PII      | |
| `cancellationReason` | string ≤200                                       |     | PHI      | |
| `cancelledBy`        | string                                            |     | internal | |
| `checkedInAt`        | timestamp                                         |     | PII      | |

Classification note: the scheduling fields (`start`, `end`, `durationMinutes`, `type`, `status`,
`checkedInAt`) are classed PII, like `admission`: they say when and with whom a person has a visit, which
admins need for scheduling and department nurses need for check-in. The clinical content of a visit,
`reason` and `cancellationReason`, is PHI and restricted by [3.4](#34-field-level-rules).

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
- `now + minLeadTimeMinutes ≤ start ≤ now + bookingWindowDays` (otherwise `400 validation-error`).
- The whole interval `[start, end)` lies inside `appointments.openingHours` on an allowed weekday, in SAST
  ([2.16](#216-systemsettings)). Otherwise `409 slot-unavailable`.
- The interval does not overlap a `scheduled` `leave` shift of the doctor ([2.12](#212-shift-staff-schedule)).
  Otherwise `409 slot-unavailable`.
- All 15-minute slot locks for the duration are free (otherwise `409 slot-unavailable`).

Reschedules run the same checks for the new interval.

`GET /practitioners/{id}/busy` returns the doctor's booked intervals (from the slot locks) merged with their
`scheduled` `leave` shifts, as `{ start, end }` only. The UI computes candidate slots as **the opening hours
of the chosen day, on 15-minute boundaries, minus the busy intervals**, minus anything before
`now + minLeadTimeMinutes`.

Booking adds the doctor to `patient.careTeam`, as it does today, whoever makes the booking (patient, nurse,
doctor or admin). This is deliberate: the booked doctor needs clinical access to conduct the visit, so the
grant goes to the treating doctor and not to the booker. A nurse or admin booking does not gain any access
themselves, and the care team change is written to `auditEvents` with the booker as actor. Booking also sets
`patient.facilityId` to the doctor's facility if it is null. When staff book for a patient whose
`facilityId` is set, the doctor must be in that facility (`400 validation-error`; system admins excepted),
the same constraint as `POST /patients/{id}/care-team`. A patient booking for themselves may choose any
active doctor: that is the patient's own referral choice.

### 2.8 Prescription (MedicationRequest)

Collection `prescriptions/{id}`.

| Field                 | Type                                   | Req | Class    | Notes |
| --------------------- | -------------------------------------- | --- | -------- | ----- |
| `patientId`           | string                                 | ✓   | internal | |
| `patientName`         | string                                 | ✓   | PII      | Snapshot |
| `prescriberId`        | string                                 | ✓   | internal | Renamed from `doctorId` |
| `prescriberName`      | string                                 | ✓   | internal | Renamed from `doctorName` |
| `facilityId`          | string                                 |     | internal | Copied from the patient at create time (`null` if the patient has none). Scopes admin reports ([2.18](#218-reports-aggregation-only-nothing-stored)); not changed when the patient moves |
| `category`            | `"inpatient" \| "outpatient"`          | ✓   | PHI      | Defaults to `inpatient` when the patient is admitted. Only inpatient prescriptions appear in the nurse medication schedule |
| `medication`          | string 1–200                           | ✓   | PHI      | Free text drug name (coded drug catalogue is **Deferred**) |
| `dose`                | string 1–50                            | ✓   | PHI      | "500 mg". Renamed from `dosage` |
| `route`               | `"oral" \| "sublingual" \| "iv" \| "im" \| "sc" \| "topical" \| "inhaled" \| "rectal" \| "ophthalmic" \| "otic" \| "nasal" \| "other"` | ✓ | PHI | Default `oral` |
| `frequency`           | see table                              | ✓   | PHI      | Replaces free-text frequency |
| `frequencyText`       | string ≤100                            |     | PHI      | Required iff `frequency = custom` |
| `administrationTimes` | `HH:mm[]` ≤12                          | ✓   | PHI      | Defaults from `frequency`. `once` requires exactly one entry; `custom` requires at least one |
| `instructions`        | string ≤2000                           |     | PHI      | Renamed from `notes` |
| `refills`             | int 0–12                               | ✓   | PHI      | Default 0 |
| `startDate`           | date                                   | ✓   | PHI      | |
| `endDate`             | date                                   |     | PHI      | `≥ startDate` |
| `status`              | `"active" \| "on-hold" \| "completed" \| "stopped" \| "entered-in-error"` | ✓ | PHI | `discontinued` migrates to `stopped` |
| `statusReason`        | string ≤200                            |     | PHI      | Required for `on-hold`, `stopped`, `entered-in-error` |
| `appointmentId`       | string                                 |     | internal | |

| `frequency`          | Default `administrationTimes`         |
| -------------------- | ------------------------------------- |
| `once`               | none: exactly one time must be supplied (single dose on `startDate` at that time) |
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

Collection `medicationAdministrations/{id}`, always with auto IDs. A scheduled dose is locked by
`administrationSlots/{prescriptionId}_{epochMillis}` `{ prescriptionId, scheduledFor, administrationId }`
([1.1](#11-identifiers)); PRN doses have no lock.

- `POST /medication-administrations` with `scheduledFor` runs one transaction: if the lock exists it returns
  `409 already-charted`; otherwise it creates the administration and the lock.
- `PATCH … { status: "entered-in-error" }` on a scheduled administration deletes its lock in the same
  transaction. The retracted administration stays in place (1.4), and the dose can be charted again with a
  new `POST`, which returns `201`. Example: a nurse charts `not-done`, the patient takes the dose later, and
  the nurse retracts the `not-done` entry and charts `completed`.

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
for that date (SAST). It loads the matching `administrationSlots` locks by deterministic ID with `getAll`,
then the administrations they point to with a second `getAll`, and returns one item per dose:

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

- `given` and `not-given`: the dose has a lock, and its administration is `completed` or `not-done`.
- Otherwise the dose is not charted. That includes a dose whose only administrations are
  `entered-in-error`, because retracting releases the lock. An uncharted dose is:
  - `due`: within ±30 minutes of `scheduledFor`;
  - `overdue`: more than 30 minutes past `scheduledFor`;
  - `upcoming`: everything earlier than the due window.

PRN prescriptions are returned separately as `prn: PrescriptionSummary[]`. Drug interaction checking is
**Deferred**.

### 2.10 CareTask

Collection `careTasks/{id}`. Nursing work items.

| Field            | Type                                                                          | Req | Class    | Notes |
| ---------------- | ----------------------------------------------------------------------------- | --- | -------- | ----- |
| `patientId`      | string                                                                        |     | internal | `null` for ward-level tasks |
| `patientName`    | string                                                                        |     | PII      | Snapshot |
| `facilityId`     | string                                                                        | ✓   | internal | Patient tasks: `patient.facilityId` (or the creator's facility if that is null). Ward-level tasks: the department's facility |
| `departmentId`   | string                                                                        |     | internal | Patient tasks: derived, see the scope rules below. Ward-level tasks: required |
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
cancelled` (the creator, or a doctor with clinical access to the task's patient; reason in
`completionNote`). Completed and cancelled tasks are terminal.
Any nurse in the department may claim an unassigned task (`assigneeId` set to themselves) or reassign within
the department. Assigning a task to someone notifies them.

Scope rules. `title`, `description`, `patientName` and `completionNote` are PHI, so department scope alone
never exposes a patient task:

- **Patient tasks** (`patientId` set). The creator must have `clinical` access to the patient. `departmentId`
  is not accepted in the body (`400`); the server sets it to the patient's current admission department, or
  `null` when the patient is not admitted. The assignee, when set, must be a nurse or doctor with `clinical`
  access to the patient (`403` otherwise). Reading or updating a patient task always requires `clinical`
  access to its patient **at request time**, in addition to the department, assignee or creator scope in
  [3.2](#32-role-to-permission-matrix). Lists apply this as an in-memory filter over the page, with one
  `getAll` of the page's distinct patients, so a nurse stops seeing a task once its patient is discharged or
  transferred out of their ward. A filtered page may hold fewer than `limit` items; `nextCursor` still
  follows the underlying query.
- **Ward-level tasks** (`patientId: null`). `departmentId` is required and must be an active department of
  the caller's facility; for nurses it must be their own department (`403` otherwise). The assignee must be
  active staff of that department.

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
| `facilityId`    | string                                                             | ✓   | internal | The staff member's facility (never taken from the body) |
| `departmentId`  | string                                                             |     | internal | Default: the staff member's department. Must be a department of `facilityId` |
| `type`          | `"morning" \| "afternoon" \| "night" \| "day" \| "on-call" \| "leave"` | ✓ | internal | `leave` blocks the time and counts as "On leave" |
| `start`, `end`  | timestamp                                                          | ✓   | internal | `end > start`, at most 24h long. No overlap for the same staff member (`409 conflict`) |
| `status`        | `"scheduled" \| "cancelled"`                                       | ✓   | internal | |
| `handoverNote`  | string ≤2000                                                       |     | PHI      | Written by the shift owner for the next shift, and only on doctor and nurse shifts (`staffRole` `doctor` or `nurse`; admins never write one). Visible only to the owner and to doctors and nurses in the same department, never to admins ([3.4](#34-field-level-rules)) |
| `handoverAt`    | timestamp                                                          |     | internal | |

"On duty" (computed) means `status = scheduled`, `type ≠ leave` and `start ≤ now < end`. Shift queries use
`start` in `[from − 24h, to)` and filter `end > from` in memory, which is valid because shifts are at most
24h long. Admins create and cancel shifts one at a time from the Roster panel ([5.4](#54-admin-admin)). A `leave`
shift also blocks the doctor's bookable time ([2.7](#27-appointment)). Recurring rotas and doctor
availability templates are **Deferred**; bookable time is the facility opening hours minus bookings and
leave.

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
| `facilityId`     | string                                                  | ✓   | The participants' facility. When a system admin takes part, the other staff members' facility; `null` only for a direct conversation between two system admins |
| `departmentId`   | string                                                  |     | `channel` only. `null` means a facility-wide channel |
| `patientId`      | string                                                  |     | Required for `patient` |
| `participantIds` | string[] 2–50                                           | ✓   | Empty for `channel` (membership is implicit) |
| `participants`   | `{ [uid]: { name, role } }`                             | ✓   | Display snapshot |
| `lastMessage`    | `{ text (≤140), senderId, senderName, sentAt }`         |     | |
| `lastMessageAt`  | timestamp                                               | ✓   | Sort key (equals `createdAt` until the first message) |
| `lastReadAt`     | `{ [uid]: timestamp }`                                  | ✓   | Not serialized. The API returns `unreadCount` for the caller instead |
| `status`         | `"active" \| "archived"`                                | ✓   | |

Type rules:

- `direct`: exactly 2 active staff in the same facility. A system admin (`facilityId: null`) may open a
  direct conversation with any active doctor, nurse or admin. The ID is deterministic, so creating it twice
  returns the existing one.
- `group`: 3 to 50 active staff of one facility, which becomes `facilityId` (system admins may join any
  facility's group as the creator).
- `channel`: created by an admin of the facility (a system admin passes `facilityId` in the body).
  `departmentId`, when set, must be a department of that facility. Any active doctor, nurse or admin of the facility (or of
  the department, when `departmentId` is set) can read and post. Patients never can.
- `patient`: **exactly one** patient participant, which must be the `userId` of the conversation's
  `patientId` (a patient without an account cannot have one, `400`). **Every other** participant must be an
  active doctor or nurse who is currently on that patient's care team. At least one such staff member is
  required. It can be created by the patient or by such a staff member. Any participant that fails these
  rules returns `403 forbidden`. Participants cannot be changed in v1 (`PATCH` accepts only `title` and
  `status`); any future participant change must re-run the same check. A staff participant later removed
  from the care team loses access through the `clinical` check in the matrix.

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
| `timeZone`      | IANA zone (validated with `Intl.supportedValuesOf`) | `Africa/Johannesburg` (used by `formatDateTime` in the UI) |

Theme, calendar view and list view preferences are not modelled: no page uses them (dark mode and calendar
views are **Deferred**), so the Settings page does not show those controls.

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
| `appointments.openingHours`                   | `{ start: HH:mm, end: HH:mm, days: int[] }` | `{ start: "08:00", end: "16:30", days: [1,2,3,4,5] }` | API (booking and reschedule) and UI (slot picker) |
| `security.sessionTimeoutMinutes`              | int 5–480     | 30              | UI (idle sign-out) |
| `maintenanceBanner`                           | string ≤300   | `null`          | UI (banner for all users) |

`openingHours` is in SAST wall-clock time. `days` uses ISO weekdays (1 = Monday … 7 = Sunday), at least one,
no duplicates. `start` and `end` are on 15-minute boundaries with `start < end`. Per-facility hours are
**Deferred**.

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
| `source`     | `"system"`                               | ✓   | Manually raised alerts are **Deferred** (adding `"manual"` later is an additive change) |
| `facilityId` | string                                   |     | `null` means system-wide. Readable by every admin, see below |
| `resource`   | ResourceRef                              |     | |
| `resolvedAt`, `resolvedBy` | timestamp, string          |     | |

The system raises one alert per staff signup ("New doctor signup awaiting approval", with a resource link to
the user), with `facilityId: null` because the signup has no facility yet. The alert is resolved
automatically when that user is approved or rejected.

Alerts contain no PHI, so every admin reads `facilityId: null` alerts: facility admins see their own
facility's alerts plus the system-wide ones (two `Filter.or` branches, both served by the
`facilityId, status, createdAt` index), and system admins see all. This matches `userScope`, which already
lets facility admins see and approve pending unassigned staff.

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

Admins have no clinical access, so for admin callers the clinical aggregates (`patients.byAcuity`,
`patients.topConditions`, `prescriptions.topMedications`) use a **small-cell rule**: any count from 1 to 4
is returned as `null` (the UI shows "<5"), and `topConditions` and `topMedications` entries with a count
below 5 are dropped. This applies to every admin report and is required when filtering by department, where
counts are small enough to point at individuals. Doctors and nurses get exact counts, because the scope is
already their clinical patients. The admin dashboard shows no clinical aggregates.

Implementation: a bounded scan with `select()` projections of the scoped patients, the appointments in the
period and the prescriptions, capped at 2,000 documents per collection (`meta.truncated` is set when the cap
is hit), aggregated in memory. The period is at most 366 days. CSV export is done client-side from this
JSON. Stored or scheduled report generation is **Deferred**.

`GET /dashboard` returns small role-specific counters that use `count()` aggregations
([4.2](#42-endpoint-catalogue)).

### 2.19 Index summary

Composite indexes for `firestore.indexes.json`. Single-field indexes are automatic. `__name__` ordering is
implicit.

The Firestore emulator does **not** enforce composite indexes, so a missing index only fails in production.
Two rules keep this safe:

- Every `scoped.*` builder ([3.6](#36-module-shape)) exposes `queryShapes(filters)`, which returns the
  `{ collection, equality: [...], arrayContains?, orderBy }` shape of every query it would issue (one per
  `Filter.or` branch). `test/indexes.test.js` enumerates every allowed filter combination for every builder
  and asserts that each shape is served by `firestore.indexes.json`: either an exact composite, or one
  `(field, orderBy)` composite per equality or array-contains field (Firestore's index merging combines
  them). A new filter without an index fails the test.
- Filter combinations are restricted to keep the set finite. On `/users`, `q` combines only with `role`
  and `status`. On `/patients`, `q` combines only with `acuity`, and `admitted` combines with neither `q`
  nor `acuity`. Other combinations return `400`.

| Collection                  | Fields                                                                 | Used by |
| --------------------------- | ---------------------------------------------------------------------- | ------- |
| `users`                     | `role, status, nameLower`                                              | directory, admin list |
| `users`                     | `facilityId, nameLower` · `facilityId, role, nameLower` · `facilityId, status, nameLower` · `facilityId, role, status, nameLower` | admin list (scoped) |
| `users`                     | `role, nameLower` · `status, nameLower`                                | system admin list |
| `users`                     | `departmentId, role, status, nameLower` · `departmentId, nameLower`     | department directory, roster staff picker |
| `users`                     | `facilityId, departmentId, nameLower`                                  | facility admin filtering by department |
| `patients`                  | `careTeam CONTAINS, nameLower`                                         | clinician list (kept) |
| `patients`                  | `careTeam CONTAINS, acuity, nameLower`                                 | acuity filter, critical count |
| `patients`                  | `admission.departmentId, nameLower` · `admission.departmentId, acuity, nameLower` | ward nurse list (OR branch) |
| `patients`                  | `facilityId, nameLower`                                                | facility admin list (system admin uses the single-field `nameLower` index) |
| `patients`                  | `admitted, nameLower`                                                  | `?admitted=` (merged with the scope index) and admitted counters |
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
| `auditEvents`               | none in v1 (write-only; the read API is **Deferred**)                  | |

### 2.20 AuditEvent

Collection `auditEvents/{autoId}`. An append-only write audit that records **who changed what, and when**,
without storing values. It meets the POPIA accountability requirement for changes to special personal
information; the per-read access log is still **Deferred**.

| Field           | Type                                                     | Req | Class    | Notes |
| --------------- | -------------------------------------------------------- | --- | -------- | ----- |
| `at`            | timestamp                                                | ✓   | internal | Server time of the write |
| `actorId`       | string                                                   | ✓   | internal | User ID, or `"system"` (migration, automatic alert resolution) |
| `actorRole`     | role \| `"system"`                                       | ✓   | internal | Snapshot |
| `action`        | `"create" \| "update" \| "status-change" \| "delete"`     | ✓   | internal | `delete` only for relationship rows (care team removal) |
| `resource`      | ResourceRef (+ `"vitals" \| "medication-administration" \| "care-team" \| "admission" \| "shift"`) | ✓ | internal | The changed document |
| `patientId`     | string                                                   |     | internal | Set whenever the resource belongs to a patient, for a future per-patient history |
| `changedFields` | string[]                                                 | ✓   | internal | Top-level field names only (`["allergies", "acuity"]`). **Never values**, so the log holds no PHI |

It is written by `writeAudit(txOrBatch, actor, { action, resource, patientId?, changedFields })` in the same
transaction or batch as the change itself, for every write to:

- patients (create, PATCH, admission, discharge, care team add and remove, including the implicit add on
  booking, and the `name` mirror written by `PATCH /me`);
- vitals, prescriptions, medication administrations, medical records (including addenda) and care tasks;
- appointments (create, status changes, reschedule);
- shifts (create, change, cancel, and every `handoverNote` write, which is PHI);
- users: any change to `role`, `status`, `facilityId` or `departmentId`, and practitioner licence fields.

AuditEvent documents carry no `updatedAt`/`updatedBy` (they are never updated) and are never serialized by
v1 endpoints. A read API for admins and a patient-facing access history are **Deferred**.

---

## 3. Authorization model

### 3.1 Principles

1. **One policy module.** `src/authz/` holds every authorization decision. Routes do not compare
   roles or IDs inline.
2. **Two layers.**
   - *Role permissions* (`resource:action`) answer "can this role ever do X?".
   - *Relationship and attribute rules* answer "can this user do X to this particular resource?".
   - Field-level redaction is a third pass applied to every response.
3. **Account status first.** Only `status = active` accounts pass, except `GET /me` and `POST /me`.
4. **Least privilege for admins.** Admins manage accounts, organisation, scheduling and demographics, so
   they see PII such as appointment times and types, admission location and register fields (patient
   `status`, `sex`, `deceasedAt`). They have **no access to clinical content** (vitals, prescriptions, administrations, medical records, care
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
| `user:list`, `user:read`            |   |   |   | ✓ | `userScope`: system admin all; facility admin own-facility staff and admins plus pending unassigned staff, never patient accounts |
| `user:update`                       |   |   |   | ✓ | `userScope`, then the invariants in [2.1](#21-user-account) (admin accounts, `role: admin` and patient accounts: system admin only) |
| `facility:read`                     | ✓ | ✓ | ✓ | ✓ | active facilities |
| `department:read`                   |   | ✓ | ✓ | ✓ | same facility (system admin: all) |
| `department:manage`                 |   |   |   | ✓ | facility (`facilityId` is immutable after create, [2.4](#24-department)) |
| `patient:list`                      |   | ✓ | ✓ | ✓ | clinical (nurse, doctor), facility (admin; patients with `facilityId: null` only for system admins) |
| `patient:read`                      | ✓ | ✓ | ✓ | ✓ | self / clinical / facility (demographics and admission only) |
| `patient:create`                    |   | ✓ | ✓ | ✓ | created in the caller's facility. Nurse and doctor creators join the care team |
| `patient:update`                    | ✓ | ✓ | ✓ | ✓ | field sets per [3.4](#34-field-level-rules) |
| `patient:read-identifier`           | ✓ | | | ✓ | self / facility |
| `patient:manage-care-team`          |   |   | ✓ | ✓ | doctor: add only, while on the care team. Admin: add and remove, facility. The added user must be in `patient.facilityId` (or the caller's facility while that is null); only system admins may add staff of another facility |
| `patient:admit`                     |   | ✓ | ✓ | ✓ | doctor and admin: admit, transfer, discharge. Nurse: transfer room or bed within their department only |
| `vitals:read`                       | ✓ | ✓ | ✓ |   | self / clinical |
| `vitals:create`                     |   | ✓ | ✓ |   | clinical |
| `vitals:retract`                    |   | ✓ | ✓ |   | author |
| `appointment:read`                  | ✓ | ✓ | ✓ | ✓ | own (patient) / own or clinical (doctor) / clinical or same department (nurse) / facility (admin). `reason` per [3.4](#34-field-level-rules) |
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
| `care-task:read`                    |   | ✓ | ✓ |   | Patient tasks: clinical for the task's patient, always; nurses additionally department, assignee or creator. Ward-level tasks: nurse department, assignee or creator; doctor creator ([2.10](#210-caretask)) |
| `care-task:create`                  |   | ✓ | ✓ |   | patient tasks need clinical access; ward-level tasks need a department of the caller's facility (nurses: their own) |
| `care-task:update`                  |   | ✓ | ✓ |   | Patient tasks: clinical for the task's patient, always; nurses additionally department or assignee, doctors creator or clinical. Ward-level tasks: nurse department or assignee; doctor creator |
| `shift:read`                        |   | ✓ | ✓ | ✓ | Doctors and nurses: own + `sameFacility` roster. Admins: `facility` (system admins must name a facility or department, see `GET /shifts`). `handoverNote` per [3.4](#34-field-level-rules) |
| `shift:manage`                      |   |   |   | ✓ | `facility`, applied to the staff member's facility |
| `shift:handover`                    |   | ✓ | ✓ |   | shift owner, on their own doctor or nurse shift |
| `notification:read`, `notification:update` | ✓ | ✓ | ✓ | ✓ | owner |
| `conversation:read`, `conversation:create`, `message:create` | ✓ | ✓ | ✓ | ✓ | participant / channel member. Patients: `patient` type only, per the type rules in [2.14](#214-conversation-and-message). Staff in a `patient` conversation must still have clinical access |
| `channel:manage`                    |   |   |   | ✓ | facility |
| `system-settings:read`              | ✓ | ✓ | ✓ | ✓ | |
| `system-settings:update`            |   |   |   | ✓ | system admin |
| `system-alert:read`, `system-alert:manage` | | |   | ✓ | facility, plus `facilityId: null` (system-wide, no PHI) alerts for every admin; system admin: all ([2.17](#217-systemalert)). `manage` is resolve only in v1 |
| `report:read`                       |   | ✓ | ✓ | ✓ | scope per [2.18](#218-reports-aggregation-only-nothing-stored) |

`GET /me` returns the caller's role permissions as `permissions: string[]`. The UI uses them to show or
hide actions. The server still enforces every rule.

### 3.3 Relationship and attribute rules

These are pure functions over `(user, resource)`, defined once in `src/authz/rules.js`:

| Rule          | Definition |
| ------------- | ---------- |
| `self`        | `resource.userId === user.id` (patient, notification, preferences), or `resource.id === user.id` (user) |
| `careTeam`    | `patient.careTeam.includes(user.id)` |
| `ward`        | `user.role === "nurse" && user.departmentId && patient.admission?.departmentId === user.departmentId && patient.facilityId === user.facilityId`. The facility check is defence in depth: the invariants in [2.1](#21-user-account), [2.4](#24-department) and [2.5](#25-patient) already keep a department inside one facility |
| `clinical`    | `user.role ∈ {doctor, nurse} && (careTeam \|\| ward)`. Child resources (vitals, prescriptions, records, administrations, tasks) inherit it from their patient |
| `author`      | `resource.createdBy === user.id` (also `authorId`, `performerId` or `prescriberId` per entity) |
| `systemAdmin` | `user.role === "admin" && user.facilityId === null` |
| `facility`    | `user.role === "admin" && (systemAdmin \|\| (user.facilityId != null && resource.facilityId === user.facilityId))`. A `null` `resource.facilityId` passes **only** for system admins |
| `sameFacility`| `user.facilityId != null && resource.facilityId === user.facilityId` (staff roster and channel membership, any staff role) |
| `department`  | `user.departmentId != null && resource.departmentId === user.departmentId`. Safe across facilities because a department ID belongs to exactly one facility forever, and a user's `departmentId` is always in their own facility ([2.1](#21-user-account)) |
| `userScope`   | `systemAdmin \|\| (facility(target) && target.role ≠ "patient") \|\| (user.role === "admin" && target.role ∈ {doctor, nurse} && target.status === "pending" && target.facilityId === null)`. The last branch is the only null-facility exception for facility admins and exists so they can approve self-signups |
| `participant` | `conversation.participantIds.includes(user.id)`, or for channels `user.role ∈ {doctor, nurse, admin} && (systemAdmin \|\| sameFacility) && (conversation.departmentId == null \|\| department \|\| user.role === "admin")` |
| `active`      | `user.status === "active"`. Checked once in middleware |

Patient access levels: `patientAccess(user, patient)` returns one of these values, and every patient-scoped
decision uses it:

- `"self"`: the patient's own account.
- `"clinical"`: a doctor or nurse who passes the `clinical` rule.
- `"administrative"`: an admin who passes the `facility` rule. A patient with `facilityId: null` is
  administrative only for system admins, so a self-registered patient who has never booked is invisible to
  every facility admin.
- `null`: no access, which is surfaced as `404`.

**Actor filters.** Several list endpoints filter by another actor: `doctorId` (appointments),
`prescriberId` (prescriptions), `authorId` (medical records), `performerId` (medication administrations),
`assigneeId` and `completedBy` (care tasks). A Firestore query cannot be intersected with `careTeam` access,
so for doctors and nurses these filters accept **only `me` or the caller's own ID**, unless the request also
has a `patientId` that the caller has `clinical` access to (the query is then patient-scoped, and the actor
filter only narrows it). Any other value returns `403 forbidden`. Patients can only use `patientId` for
their own patient (their query is always pinned to their own `patientId`, so an actor filter can only
narrow their own data). Admins may filter appointments by any `doctorId` whose `facilityId` passes `facility`; admins
have no access to the other clinical lists. For care tasks, nurses may also use `assigneeId=unassigned` and
any `assigneeId` of a nurse in their own department, because department scope is applied in the same query.

### 3.4 Field-level rules

Applied by `redact(user, type, doc)` on every serialized document, including list items and embedded
snapshots.

| Entity.field                                                          | Visible to |
| --------------------------------------------------------------------- | ---------- |
| `Patient.identifier`                                                  | self, administrative |
| `Patient.{allergies, noKnownAllergies, chronicConditions, bloodType, latestVitals, acuity}` | self, clinical |
| `Patient.admission`                                                   | self, clinical, administrative (bed management; PII, see [2.5](#25-patient)) |
| Other `Patient` fields                                                | self, clinical, administrative |
| `User.{identifier, emergencyContact, phone}`                          | self, admin (`userScope`) |
| `User.email`                                                          | self, admin (`userScope`) |
| `PractitionerSummary.email`                                           | doctors, nurses and admins. Omitted for patients |
| `User.{lastSignInAt, emailVerified}`                                  | admin (`userScope`) |
| `Appointment.{reason, cancellationReason}`                            | self, or a caller with `clinical` access to the appointment's patient. Never admins, and never a nurse who sees the appointment only through department scope |
| `Shift.handoverNote` (also `previousHandover` in `/shifts/current`)   | the shift owner, and doctors and nurses whose `department` rule passes for the shift. Never admins |
| Admin `ReportSummary` clinical aggregates                             | small-cell rule in [2.18](#218-reports-aggregation-only-nothing-stored) |
| `MedicalRecord` with status `preliminary` or `entered-in-error`       | Hidden from the patient: the row is excluded, not just redacted |
| `Conversation.lastReadAt`                                             | never (replaced by the caller's `unreadCount`) |
| `legacy`, `nameLower`, `conditionCategories`, `expiresAt`, `schemaVersion` | never |

Writable field sets for `PATCH /patients/{id}`. Any field outside the caller's set returns `403 forbidden`
and names the field:

| Access level     | Writable fields |
| ---------------- | --------------- |
| `self`           | `name, givenName, familyName, phone, email, address, emergencyContact`. **Not** `identifier`: a self-asserted ID number is unverified, and reserving it in `patientIdentifiers` would let any public signup squat a real person's ID number. Patients see their `identifier` read-only (masked) |
| `clinical`       | `name, givenName, familyName, birthDate, sex, phone, email, address, emergencyContact, folderNumber, bloodType, allergies, noKnownAllergies, chronicConditions, acuity`. Doctors also: `status, deceasedAt`. Staff can set `identifier` **only on `POST /patients`** (write-only) |
| `administrative` | `name, givenName, familyName, birthDate, sex, phone, email, address, emergencyContact, folderNumber, identifier, status` (`inactive` or `active` only). System admins also: `facilityId` |

`409 duplicate-identifier` on staff `POST /patients` (and on an administrative `PATCH` of `identifier`)
tells the caller that some patient with that ID number is already registered, without revealing which.
This is an **accepted disclosure**: only active, approved staff (nurses, doctors and admins) can trigger it,
because only they can write `identifier`; it is needed to prevent duplicate records; and the response
contains no patient ID or name. Patients cannot set or change `identifier` in v1 (`PATCH` returns `403`), so
a self-registered patient has `identifier: null` until staff register them.

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
// src/authz/ (index.js re-exports permissions, rules, policy, redact, scoped, query and loaders)
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
- `src/authz/` has no Firestore writes (only the loaders read) and the predicates are pure, so most of it is unit-tested without
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
| N  | GET    | `/api/openapi.json`     | OpenAPI 3.1 | Unversioned, cacheable |
| N  | GET    | `/api/docs`             | Swagger UI | |
| C  | POST   | `/api/v1/auth/signup`   | `201 { id, status: "pending" }` | Body: `{ email, password (8–128), name, phone, role: "doctor"\|"nurse", identifier: Identifier, licenceNumber?, specialization? }`. Renamed `fullName → name`, `phoneNumber → phone`, `nationalId → identifier`. Raises a SystemAlert. `409 conflict` if the email equals `BOOTSTRAP_ADMIN_EMAIL` (same comparison as `POST /me`), so nobody can pre-register the bootstrap admin's address and lock the owner into a pending staff account. The account starts unverified; approval requires a verified email ([2.1](#21-user-account)) |

#### Me

| St | Method | Path               | Permission           | Request | Response |
| -- | ------ | ------------------ | -------------------- | ------- | -------- |
| C  | GET    | `/me`              | signed in (any status) | – | `{ user: User, patient: Patient \| null, permissions: string[] }`. `404 not-found` means onboarding is needed |
| C  | POST   | `/me`              | signed in, no profile | `{ name?, phone?, birthDate?, sex? }` | `201` with the same shape as `GET /me`. Normally creates `users/{uid}` (`role: patient, status: active`) and `patients/{uid}` (`userId` = uid, `phone`/`birthDate`/`sex` from the body, `email` from the token as the initial contact email). **Bootstrap admin:** if the token's email is verified and equals the `BOOTSTRAP_ADMIN_EMAIL` environment variable (trimmed, case-insensitive), the profile is created as `role: admin, status: active, facilityId: null` (a system admin) and no patient document is created. This is the only way to create the first system admin; the existing test stays. `409 conflict` if the profile exists |
| C  | PATCH  | `/me`              | `profile:update`     | Staff and admins: `{ name?, phone?, emergencyContact?, practitioner?: { specialization?, qualifications?, practisingSince?, officeLocation?, bio? } }`. Patients: `{ name? }` only; `phone` and `emergencyContact` return `403 forbidden` (they live on the Patient, edit them with `PATCH /patients/{patient.id}`) | Same shape as `GET /me`. A name change is mirrored to the linked patient in the same batch |
| N  | GET    | `/me/preferences`  | `preferences:read`   | – | `UserPreferences` (with defaults filled in) |
| N  | PATCH  | `/me/preferences`  | `preferences:update` | Partial `UserPreferences` (deep-merged) | `UserPreferences` |

#### Dashboard and reports

| St | Method | Path               | Permission       | Response |
| -- | ------ | ------------------ | ---------------- | -------- |
| N  | GET    | `/dashboard`       | `dashboard:read` | Role-specific (OpenAPI `oneOf` with discriminator `role`), not paginated. See the shapes below |
| N  | GET    | `/reports/summary?from=&to=&facilityId=&departmentId=` | `report:read` | `ReportSummary`. `facilityId` is for system admins; `departmentId` is for admins |
| R  | GET    | `/admin/stats`     | – | Replaced by `GET /dashboard` for admins |

Dashboard shapes. Counts are `count()` aggregations, except the nurse `medicationsDueNow` counter and the
`overdue-medication` alerts: those come from the medication schedule function in
[2.9](#29-medicationadministration), computed for today over the caller's accessible inpatients (it is not
stored, so it cannot be counted with an aggregation). The nurse `tasksDueToday` counter and the
`overdue-task` alerts are not aggregations either: open tasks in the nurse's task scope due before the end
of today (at most 500, by `dueAt`) are fetched and kept only where `care-task:read` passes, so a patient
task drops out once the patient is discharged or transferred ([2.10](#210-caretask)).

- `patient`: `{ role, counters: { upcomingAppointments, activePrescriptions, unreadNotifications } }`
- `doctor`: `{ role, counters: { patients, appointmentsToday, pendingAppointments, preliminaryRecords, activePrescriptions } }`
- `nurse`: `{ role, counters: { patientsUnderCare, tasksDueToday, medicationsDueNow, criticalPatients }, alerts: { type: "critical-patient" | "overdue-medication" | "overdue-task", patientId?, patientName?, message, at }[] }` (at most 10 alerts)
- `admin`: `{ role, counters: { doctors, nurses, patients, admittedPatients, pendingStaff, upcomingAppointments, activeSystemAlerts, totalUsers, activeUsers, disabledUsers } }`
  Counters follow the caller's scope: facility admins count their facility (and `activeSystemAlerts`
  includes system-wide alerts, as in [2.17](#217-systemalert)); system admins count everything.
  `pendingStaff` matches `userScope`: pending doctors and nurses in the admin's facility **plus** pending
  unassigned ones (`facilityId: null`); for system admins, all pending staff.

#### Users, directory, organisation

| St | Method | Path                           | Permission          | Request / query | Response |
| -- | ------ | ------------------------------ | ------------------- | --------------- | -------- |
| C  | GET    | `/users?role=&status=&facilityId=&departmentId=&q=` | `user:list` | Scoped by `userScope` ([3.3](#33-relationship-and-attribute-rules)): facility admins get their facility's staff and admins plus pending unassigned staff, never `role=patient` (`role=patient` returns `403`); `facilityId` is for system admins. `q` is a case-insensitive prefix match on name | page of `User` (with `lastSignInAt`), sorted by `nameLower` |
| N  | GET    | `/users/{id}`                  | `user:read`         | – | `User` (`404` outside `userScope`) |
| C  | PATCH  | `/users/{id}`                  | `user:update`       | `{ role?: "doctor"\|"nurse"\|"admin", status?, statusReason?, facilityId?, departmentId?, practitioner?: Partial<Practitioner> }` | `User`. Activating staff requires `facilityId` (and `departmentId` for nurses, plus `practitioner.licenceNumber`); otherwise `400`. Activating also requires the Firebase Auth `emailVerified === true` (`409 invalid-state-transition`). `departmentId` must be an active department of the target's resulting `facilityId`, and any `facilityId` change must also set or clear `departmentId` in the same request (`400`). Enforces every invariant in [2.1](#21-user-account): no self-change of `role`/`status`/`facilityId`/`departmentId`; only system admins touch admin accounts, patient accounts, `role: admin` or an admin's `facilityId`; facility admins only manage doctors and nurses in their facility or pending unassigned ones, and may only set `facilityId` to their own; the last active system admin keeps `role`, `status` and `facilityId: null` (`409`). Writes `auditEvents` |
| R  | GET    | `/doctors`                     | – | – | Replaced by `/practitioners?role=doctor` |
| N  | GET    | `/practitioners?role=&facilityId=&departmentId=&q=` | `practitioner:list` | Active staff only | page of `PractitionerSummary` (patients: doctors only) |
| N  | GET    | `/practitioners/{id}/busy?from=&to=` | `practitioner:read-busy` | Window at most 31 days | `{ data: { start, end }[] }`: booked slots merged with `scheduled` `leave` shifts (not paginated, no PHI, no reason why a time is busy) |
| N  | GET    | `/facilities`                  | `facility:read`     | `?status=` (admin) | page of `Facility`. Facility create and edit are **Deferred** (seed and migration create them) |
| N  | GET    | `/departments?facilityId=&include=stats` | `department:read` | `include=stats` is admin only | page of `Department` (+ `stats`) |
| N  | POST   | `/departments`                 | `department:manage` | `Department` fields. `facilityId` must pass `facility`: facility admins may omit it (own facility) or send their own; system admins must send it | `201 Department` |
| N  | PATCH  | `/departments/{id}`            | `department:manage` | partial, **without** `facilityId` (immutable; sending it returns `400`) | `Department` |

#### Patients

| St | Method | Path                                         | Permission                 | Request / query | Response |
| -- | ------ | -------------------------------------------- | -------------------------- | --------------- | -------- |
| C  | GET    | `/patients?q=&acuity=&admitted=true&facilityId=` | `patient:list`         | Sorted by `nameLower`. Scope: clinical for doctors and nurses; `facilityId == own` for facility admins; everything (or `facilityId=`) for system admins. `acuity` is not accepted from admins | page of `Patient` (redacted) |
| C  | POST   | `/patients`                                  | `patient:create`           | `{ name, givenName?, familyName?, birthDate?, sex?, phone?, email?, address?, emergencyContact?, identifier?, folderNumber?, bloodType?, allergies?, noKnownAllergies?, chronicConditions?, acuity?, facilityId? (system admin) }`. Admins may not send the clinical fields (`bloodType`, `allergies`, `noKnownAllergies`, `chronicConditions`, `acuity`) | `201 Patient`. `409 duplicate-identifier` (accepted staff-only disclosure, [3.4](#34-field-level-rules)) |
| C  | GET    | `/patients/{id}`                             | `patient:read`             | – | `Patient` |
| C  | PATCH  | `/patients/{id}`                             | `patient:update`           | Partial patient, using the per-access writable set ([3.4](#34-field-level-rules)). `careTeam`, `room` and `nextMed` are no longer accepted | `Patient` |
| N  | GET    | `/patients/{id}/care-team`                   | `patient:read`             | – | `{ data: PractitionerSummary[] }` (not paginated, at most 50). Patients get it for themselves so they can start a conversation |
| N  | POST   | `/patients/{id}/care-team`                   | `patient:manage-care-team` | `{ userId }` (active doctor or nurse in `patient.facilityId`, or in the caller's facility while that is null; system admins may add staff of any facility. Otherwise `400`) | `201 { data: PractitionerSummary[] }`. Notifies the added staff member. Cross-facility referral by doctors and facility admins is **Deferred** |
| N  | DELETE | `/patients/{id}/care-team/{userId}`          | `patient:manage-care-team` (admin) | – | `204` |
| N  | POST   | `/patients/{id}/admission`                   | `patient:admit`            | `{ departmentId, ward?, room?, bed?, attendingDoctorId? }`. `departmentId` must be an active department in `patient.facilityId` ([2.5](#25-patient)), otherwise `400` | `201 Patient`. `409` if already admitted |
| N  | PATCH  | `/patients/{id}/admission`                   | `patient:admit`            | `{ departmentId?, ward?, room?, bed?, attendingDoctorId? }` (nurses: `ward, room, bed` only). A new `departmentId` must be in `patient.facilityId` (`400`) | `Patient` |
| N  | POST   | `/patients/{id}/admission/discharge`         | `patient:admit` (doctor, admin) | `{ dischargeNote? }` | `Patient` (`admission: null`) |
| C  | GET    | `/patients/{id}/vitals?status=`              | `vitals:read`              | Sorted by `recordedAt` desc. Excludes `entered-in-error` by default | page of `VitalSigns` |
| C  | POST   | `/patients/{id}/vitals`                      | `vitals:create`            | `VitalSigns` measurements + `recordedAt?`, `notes?` | `201 VitalSigns` |
| N  | PATCH  | `/patients/{id}/vitals/{vitalsId}`           | `vitals:retract`           | `{ status: "entered-in-error", statusReason }` | `VitalSigns` |

#### Appointments

| St | Method | Path                                          | Permission           | Request / query | Response |
| -- | ------ | --------------------------------------------- | -------------------- | --------------- | -------- |
| C  | GET    | `/appointments?patientId=&doctorId=&departmentId=&status=&from=&to=` | `appointment:read` | Default scope: patient (own), doctor (own schedule), nurse (`patientId` or own department), admin (facility). `doctorId` follows the actor filter rule ([3.3](#33-relationship-and-attribute-rules)): doctors may pass only `me`/own ID unless `patientId` is set and clinical, admins any doctor in their facility; otherwise `403`. Nurses may pass `doctorId` only with `patientId` (`400` otherwise). A facility admin's `doctorId` list is still pinned to the admin's facility (`facilityId` is copied from the doctor at booking, so a doctor who moved keeps the old facility's bookings out of scope). Admins cannot combine `doctorId` with `departmentId` (`400`). `departmentId` must be the caller's own for nurses. Sorted by `start` asc. `upcoming=true` is replaced by `from=<now>` | page of `Appointment` |
| C  | POST   | `/appointments`                               | `appointment:create` | `{ doctorId, patientId? (staff), start, durationMinutes?, type?, reason? }` | `201 Appointment`. `409 slot-unavailable` |
| N  | GET    | `/appointments/{id}`                          | `appointment:read`   | – | `Appointment` |
| C  | PATCH  | `/appointments/{id}`                          | `appointment:update` | `{ status?, cancellationReason?, start?, durationMinutes?, type?, reason? }`. Transitions per [2.7](#27-appointment). Patients may send only `status: "cancelled"`, `cancellationReason`, `start` and `durationMinutes` | `Appointment`. `409 invalid-state-transition` |

#### Prescriptions and medication administration

| St | Method | Path                                         | Permission                          | Request / query | Response |
| -- | ------ | -------------------------------------------- | ----------------------------------- | --------------- | -------- |
| C  | GET    | `/prescriptions?patientId=&prescriberId=&status=&category=` | `prescription:read` | Patients: own. Doctors without `patientId`: `prescriberId` defaults to and must be `me`/own ID (`403` otherwise); with a clinical `patientId`, any `prescriberId` narrows that patient's list. Nurses must pass a clinical `patientId` (`400 validation-error` without one; `404` if it is not clinical). Sorted by `createdAt` desc. Excludes `entered-in-error` unless asked | page of `Prescription` |
| C  | POST   | `/prescriptions`                             | `prescription:create`               | `{ patientId, medication, dose, route?, frequency, frequencyText?, administrationTimes?, instructions?, refills?, startDate, endDate?, category?, appointmentId? }` | `201 Prescription` |
| N  | GET    | `/prescriptions/{id}`                        | `prescription:read`                 | – | `Prescription` |
| C  | PATCH  | `/prescriptions/{id}`                        | `prescription:update`               | `{ status?, statusReason?, endDate?, refills?, instructions?, administrationTimes? }` | `Prescription` |
| N  | POST   | `/prescriptions/{id}/refill-requests`        | `prescription:request-refill`       | `{ note? }` (≤500) | `202 { status: "requested" }`. Notifies the prescriber; nothing else is stored (refill workflow **Deferred**) |
| N  | GET    | `/medication-schedule?date=&departmentId=`   | `medication-schedule:read`          | `date` defaults to today (SAST). `departmentId` is for nurses only and must be their own department (`403` otherwise); it only narrows the accessible inpatients to that ward | `{ data: ScheduledDose[], prn: Prescription[] }` (not paginated) |
| N  | GET    | `/medication-administrations?patientId=&prescriptionId=&performerId=&from=&to=` | `medication-administration:read` | At least one of `patientId`, `prescriptionId` (its patient must be clinical or self) or `performerId`. Without a clinical `patientId`/`prescriptionId`, `performerId` must be `me`/own ID (`403` otherwise). Sorted by `occurredAt` desc | page of `MedicationAdministration` |
| N  | POST   | `/medication-administrations`                | `medication-administration:create`  | `{ prescriptionId, scheduledFor?, status: "completed"\|"not-done", statusReason?, occurredAt?, dose?, notes? }` | `201 MedicationAdministration`. With `scheduledFor`, creates the `administrationSlots` lock in the same transaction; `409 already-charted` if a live administration holds it ([2.9](#29-medicationadministration)) |
| N  | PATCH  | `/medication-administrations/{id}`           | `medication-administration:retract` | `{ status: "entered-in-error", statusReason }` | `MedicationAdministration`. Releases the slot lock in the same transaction, so the dose can be re-charted |

#### Medical records

| St | Method | Path                                | Permission              | Request / query | Response |
| -- | ------ | ----------------------------------- | ----------------------- | --------------- | -------- |
| C  | GET    | `/medical-records?patientId=&authorId=&category=&status=` | `medical-record:read` | Patients: own, final and amended only. Doctors and nurses without `patientId`: `authorId` defaults to and must be `me`/own ID (`403` otherwise). Sorted by `effectiveAt` desc | page of `MedicalRecord` |
| C  | POST   | `/medical-records`                  | `medical-record:create` | `{ patientId, category, title, effectiveAt?, status?: "preliminary"\|"final", diagnosis?, diagnosisCode?, findings?, treatment?, recommendations?, labResults?, appointmentId? }` | `201 MedicalRecord` |
| N  | GET    | `/medical-records/{id}`             | `medical-record:read`   | – | `MedicalRecord` |
| C  | PATCH  | `/medical-records/{id}`             | `medical-record:update` | While preliminary: content fields and/or `status: "final"`. At any status: `{ status: "entered-in-error", statusReason }` | `MedicalRecord`. `409 record-immutable` |
| N  | POST   | `/medical-records/{id}/addenda`     | `medical-record:update` | `{ text }` (final or amended only) | `201 MedicalRecord` (status `amended`) |

#### Care tasks and shifts

| St | Method | Path                     | Permission         | Request / query | Response |
| -- | ------ | ------------------------ | ------------------ | --------------- | -------- |
| N  | GET    | `/care-tasks?assigneeId=&departmentId=&patientId=&status=&priority=&dueBefore=&completedBy=&completedAfter=` | `care-task:read` | `assigneeId` accepts `me`, `unassigned` and (nurses) a nurse of the caller's own department; `completedBy` accepts only `me`; `departmentId` must be the caller's own. Doctors may use other actor values only with a clinical `patientId`. Anything else returns `403` ([3.3](#33-relationship-and-attribute-rules)). Default for nurses: own department, `status = open,in-progress`. Sorted by `dueAt` asc (by `completedAt` desc when filtering on `completedBy`) | page of `CareTask` |
| N  | POST   | `/care-tasks`            | `care-task:create` | `{ patientId?, title, description?, category, priority?, dueAt, assigneeId?, departmentId? }`. Patient tasks: `departmentId` is not accepted (derived from the admission) and the assignee must have clinical access. Ward-level tasks: `departmentId` required, in the caller's facility (nurses: own department). See [2.10](#210-caretask) | `201 CareTask` |
| N  | GET    | `/care-tasks/{id}`       | `care-task:read`   | – | `CareTask` |
| N  | PATCH  | `/care-tasks/{id}`       | `care-task:update` | `{ status?, assigneeId?, title?, description?, priority?, dueAt?, completionNote? }` | `CareTask`. `409 invalid-state-transition` |
| N  | GET    | `/shifts?staffId=&departmentId=&facilityId=&from=&to=` | `shift:read` | `staffId` accepts `me`. Window at most 31 days. Scoped to the caller's facility (another staff member's `staffId` list only returns shifts whose `facilityId` is the caller's, so shifts from a previous facility stay out of scope). System admins must pass `facilityId` or `departmentId` (`400` otherwise), or `staffId=me`; `facilityId` is for system admins only. Sorted by `start` asc. `handoverNote` redacted per [3.4](#34-field-level-rules) | page of `Shift` |
| N  | GET    | `/shifts/current`        | `shift:read`       | – | `{ shift: Shift \| null, previousHandover: { note, staffName, at } \| null, onDuty: { staffId, staffName, staffRole, type }[] }` (same department, not paginated) |
| N  | POST   | `/shifts`                | `shift:manage`     | `{ staffId, type, start, end, departmentId? }`. The staff member must be active and pass `facility` (facility admins: their own facility; system admins: any). The shift's `facilityId` is the staff member's facility, and `departmentId` must be a department of it | `201 Shift`. `409 conflict` on overlap. Used by the admin Roster panel |
| N  | PATCH  | `/shifts/{id}`           | `shift:manage` / `shift:handover` | Admin: `{ type?, start?, end?, departmentId?, status? }` (`status: "cancelled"` to cancel). Owner of a doctor or nurse shift: `{ handoverNote }`. Admins never write handover notes (`403`) | `Shift` |

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
| N  | POST   | `/conversations`                       | `conversation:create` (`channel:manage` for channels) | `{ type, participantIds?, title?, patientId?, departmentId?, facilityId? (system admins, channels) }`. Type rules in [2.14](#214-conversation-and-message); `patient` conversations: exactly the patient's account plus active care team doctors and nurses, otherwise `403` | `201 Conversation` (`200` with the existing one for duplicate `direct`) |
| N  | GET    | `/conversations/{id}`                  | `conversation:read`  | – | `Conversation` |
| N  | PATCH  | `/conversations/{id}`                  | `channel:manage` (channels) / participant (groups: `title` only) | `{ title?, status? }` (participants cannot be changed in v1) | `Conversation` |
| N  | GET    | `/conversations/{id}/messages`         | `conversation:read`  | Sorted by `createdAt` desc | page of `Message` |
| N  | POST   | `/conversations/{id}/messages`         | `message:create`     | `{ text }` | `201 Message`. Updates `lastMessage`, `lastMessageAt` and the sender's `lastReadAt` |
| N  | POST   | `/conversations/{id}/read`             | `conversation:read`  | – | `204`. Sets `lastReadAt[caller] = now` |

#### System settings and alerts

| St | Method | Path                    | Permission               | Request | Response |
| -- | ------ | ----------------------- | ------------------------ | ------- | -------- |
| N  | GET    | `/system-settings`      | `system-settings:read`   | – | `SystemSettings` (with defaults filled in) |
| N  | PATCH  | `/system-settings`      | `system-settings:update` | Partial (deep-merged) | `SystemSettings` |
| N  | GET    | `/system-alerts?status=&severity=` | `system-alert:read` | Sorted by `createdAt` desc | page of `SystemAlert` |
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
14. Admins lose read access to clinical resources (vitals, prescriptions, medical records), to appointment
    `reason` and to patient `acuity`. Facility admins no longer see patient accounts or patients without a
    facility.
15. For patient accounts, `phone` and `emergencyContact` move from `users/{uid}` to the Patient. `PATCH /me`
    rejects them for patients.
16. `GET /practitioners/{id}/busy` also returns leave, and booking enforces opening hours.

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
| `utils/patients.js` (`toPatientCard`) | – | Read `birthDate` (not `dateOfBirth`), `admission?.room`/`bed` (not `room`), `acuity` (not `priority`), `sex` (not `gender`), and `folderNumber`. Status label comes from `labelFor(acuity)` via `utils/status.js`, not a `critical ? … : …` ternary |
| `utils/format.js` | – | `healthStatsFromVitals` reads `bloodGlucose` in mmol/L (not `bloodSugar` mg/dL) and formats `bloodPressure` with `formatBloodPressure`. `ageFromDob` takes `birthDate`. Add `formatDateTime`, `formatBloodPressure`, `labelFor` (see 5.9) |
| `Components/PatientCard/PatientCard.jsx` | – | Props `sex` (replacing `gender`) and `folderNumber`. **Remove** the `lastVisit` prop (see 5.5). Show "Folder {folderNumber}" when present instead of the opaque Firestore "ID: {patientId}"; the ID is only used as the React key and link target. `acuity` badge through `StatusBadge` |
| `Components/Sidebar.jsx` | – | Add `Messages` for patients, `Team Chat` for doctors (both routes exist but are not linked) and `Patients` (`/admin/patients`, new) for admins. Hide items whose permission is missing |
| `api/client.js` | all | Base URL `${VITE_API_BASE_URL}/v1`. Parse problem+json into `ApiError { status, code, message, errors }`. Add a `listAll`/`paginate` helper using `nextCursor`. One function per endpoint in 4.2 |

### 5.2 Public pages

| Route | Component | Endpoints | Notes |
| ----- | --------- | --------- | ----- |
| `/` | `Pages/LandingPage.jsx` | – (Google sign-in, then `/dashboard`) | Tab-indented file, keep its style |
| `/staff-sign-up` | `Pages/StaffSignUp.jsx` | `POST /auth/signup` | Fields `name, identifier {type, value}, email, phone, role, password, licenceNumber?, specialization?`. Remove the `admin` option. On success, sign in with `signInWithEmailAndPassword`, call Firebase `sendEmailVerification(currentUser)` (Firebase delivers it), and show "Check your inbox to verify your email; your account then awaits approval" instead of redirecting to `/role-selection`. A `409 conflict` shows a generic "this email cannot be used for staff sign-up" |
| `/role-selection` | `Pages/RoleSelection.jsx` | – | **Delete** the route, the page and `Components/RoleSelection/*`. The role comes from the account, so a role picker is misleading |
| `/dashboard` | `RequireRole` | `GET /me` | Unchanged |

### 5.3 Shared role pages (`/{role}/settings|profile|notifications|team-chat`)

| Component | Endpoints | Fields and behaviour |
| --------- | --------- | -------------------- |
| `Components/Settings/Settings.jsx` | `GET`, `PATCH /me/preferences` | `notifications.{inApp,email,sms}` (email and SMS labelled "not yet delivered"), `language` (en, af, zu, xh; labelled "English only for now"), `timeZone` (default Africa/Johannesburg, replacing the US zones). **Remove** the theme, calendar view and list view controls (not modelled, see [2.15](#215-userpreferences)). Save button with optimistic state. Security card: "Change password" calls Firebase `sendPasswordResetEmail(user.email)` for password accounts and links to Google account settings for Google accounts. **Remove** 2FA and login history (Deferred) |
| `Components/ProfilePage/Profile.jsx` + `ProfileCard`, `ProfessionalInformationSection`, `ContactInformationSection`, `ScheduleOverview` | `GET /me` (context), `PATCH /me`, `GET /shifts?staffId=me&from=<today>&to=<+7d>`, patients: `PATCH /patients/{patient.id}` | **Replace the hardcoded "Dr. Sarah Connor".** ProfileCard: `user.name`, `user.photoUrl` (fallback `assets/default-avatar.svg`), title = role label + `practitioner.specialization`. Professional section (staff only): `practitioner.licenceBody`/`licenceNumber`, `specialization`, experience from `practisingSince`, `qualifications[]`, `officeLocation`. Contact section: staff and admins read and edit `user.email` (read-only, sign-in), `user.phone`, `user.emergencyContact` through `PATCH /me`. **Patients** read and edit contact data in one place, the Patient: `patient.phone`, `patient.email` (labelled "Contact email"), `patient.emergencyContact`, `address`, through `PATCH /patients/{patient.id}`; `user.email` is shown read-only as "Sign-in email". ScheduleOverview (staff only): upcoming shifts (`type`, `start`–`end`, department). Patients also see a demographics section: `patient.birthDate`, `sex`, `folderNumber`, `identifier` (read-only, masked except the last 4 digits; only staff can set it). "Edit Profile" opens one form: staff post to `PATCH /me`; patients post `name` to `PATCH /me` and the contact fields (`phone`, `email`, `address`, `emergencyContact`) to `PATCH /patients/{patient.id}` |
| `Components/Notifications/Notifications.jsx` (+ `NotificationList`, `NotificationItem`, `FilterSortControls`, `NotificationIcon`) | `GET /notifications?unread=`, `PATCH /notifications/{id}`, `POST /notifications/read-all` | Filter calls the server with `unread=true` instead of filtering client-side. Sort newest first by default (oldest-first is client-side within loaded pages). "Load more" with `nextCursor`. Click navigates to `resource` when present. Add a "Mark all read" button |
| `Components/TeamChat/TeamChat.jsx` | `GET /conversations`, `POST /conversations`, `GET /conversations/{id}/messages`, `POST /conversations/{id}/messages`, `POST /conversations/{id}/read`, `GET /practitioners?q=` (new direct message) | Sidebar: channels (`type = channel`), direct and group conversations, and a "Patients" section (`type = patient`) for staff. Header user from `/me`. Poll messages every 15 s while open. **Admins** (`can("channel:manage")`) get a "New channel" button (title, optional department from `GET /departments`) posting `POST /conversations { type: "channel" }`, and an "Archive channel" action (`PATCH /conversations/{id} { status: "archived" }`). **Remove** presence dots, phone and video buttons, emoji and attachments (Deferred) |

### 5.4 Admin (`/admin/*`)

| Route | Component | Endpoints | Fields and behaviour |
| ----- | --------- | --------- | -------------------- |
| `dashboard` | `Components/AdminDashboard/AdminDashboard.jsx` | `GET /dashboard`, `GET /shifts?from=<now>&to=<now+1m>` (on duty now), `GET /system-alerts?status=active&limit=5`, `GET /reports/summary` (charts), `GET /facilities` (system admins) | StatsGrid: `counters.doctors, nurses, patients, pendingStaff, upcomingAppointments, admittedPatients`. **StaffSchedule** (replaces `MockData.staffSchedule`): `staffName`, shift `type`, "On duty" or "On leave". System admins (`user.facilityId === null`) get a facility select from `GET /facilities` (default: the first) and pass `facilityId` to `GET /shifts`. **SystemAlerts** (replaces `MockData.systemAlerts`): `severity` (info, warning, critical), `title`/`message`, relative `createdAt`, and a resolve button calling `PATCH /system-alerts/{id}`. **Analytics**: render "Patient demographics" (`patients.bySex`, `byAgeGroup`) and "Appointment distribution" (`appointments.byStatus`) from the report summary. **Remove** "Revenue Analytics" and "Resource Utilization". QuickActions become links: pending approvals, patients (`/admin/patients`), reports, system settings |
| `user-management` | `Components/AdminDashboard/UserManagement.jsx` | `GET /users?role=&status=&q=&cursor`, `GET /users/{id}`, `PATCH /users/{id}`, `GET /departments`, `GET /dashboard` (stat cards) | Replace `mockUsers` and `stats`. Status filter values are `active`, `pending` and `disabled` (not `inactive`). Columns: name, email, role, department (resolved from `departmentId`), status, `lastSignInAt`. Columns also show an "Email not verified" badge when `emailVerified` is false, and the approve action is disabled for those rows (the API returns `409`). Actions: approve (requires facility, licence, and department for nurses; the department picker lists only departments of the chosen facility), disable/enable with `statusReason`, change role, view details (drawer showing `identifier`, `emergencyContact`, `practitioner`). Stat cards: `counters.totalUsers, activeUsers, pendingStaff, disabledUsers`. **Remove** "Add New User" (admin invites are Deferred) or replace it with "Copy staff sign-up link" |
| `department-settings` | `Components/AdminDashboard/DepartmentSettings.jsx` | `GET /departments?include=stats`, `POST /departments`, `PATCH /departments/{id}`, `GET /users?role=doctor,nurse` (head picker) | Replace `mockDepartments` and `overallStats`. Card: `name`, `headName`, `stats.staff`, `bedCapacity`, `stats.admittedPatients`, `stats.occupancyRate`, `stats.appointmentsToday`, `location`. Overall cards: department count, sum of staff, average occupancy (computed client-side). **Roster panel** per department (this is the only shift write path, and it feeds the admin StaffSchedule, the nurse ShiftInfo and `onDuty`, the Profile ScheduleOverview and doctor leave in booking): `GET /shifts?departmentId=&from=&to=` for a 7-day window, "Add shift" form (staff picker from `GET /users?departmentId=&status=active&role=doctor,nurse`, `type` including `leave`, `start`, `end`) posting `POST /shifts`, and "Cancel" (`PATCH /shifts/{id} { status: "cancelled" }`). `409 conflict` shows "overlaps an existing shift". **Remove** budget, equipment and the quick actions except "Assign staff" (link to user management `?departmentId=`). Archive is `PATCH status: archived` |
| `patients` (**new route** in `App.jsx` and the admin sidebar) | `Components/AdminDashboard/AdminPatients.jsx` | `GET /patients?q=&cursor`, `POST /patients`, `PATCH /patients/{id}`, `GET /patients/{id}/care-team`, `POST /patients/{id}/care-team`, `DELETE /patients/{id}/care-team/{userId}`, `GET /practitioners?q=` (care team picker) | Reception and records view for administrative access: register a walk-in patient (demographics, `identifier`, `folderNumber`, no clinical fields), edit demographics or deactivate (`status: inactive`), and manage the care team (add or remove a doctor or nurse). Columns: `name`, `folderNumber`, age, `sex`, `admission` (department, room, bed). No clinical fields are shown. Reuses the shared patient table (`TableHead`, `LoadMore`) with `PatientRecords` |
| `reports` | `Components/AdminDashboard/AdminReports.jsx`, replaced by the shared `ReportsPage` | `GET /reports/summary?from=&to=&departmentId=` | Route renders the shared reports page (see 5.5). **Delete** the report catalogue, templates, "recent reports" and downloads mock (stored reports are Deferred). Export is client-side CSV |
| `system-settings` | `Components/AdminDashboard/SystemSettings.jsx` | `GET`, `PATCH /system-settings`, `GET /api/health` (version) | Tabs: General (`organisationName`, `supportEmail`, `supportPhone`, `defaultTimeZone`, `defaultLanguage`, `maintenanceBanner`), Appointments (`appointments.*`), Security (`security.sessionTimeoutMinutes`). Controlled inputs, real Save and Cancel. System status card: API `version` and region only. **Remove** the backup, integrations and maintenance tabs and the fake storage and uptime numbers |

### 5.5 Doctor (`/doctor/*`)

| Route | Component | Endpoints | Fields and behaviour |
| ----- | --------- | --------- | -------------------- |
| `dashboard` | `Components/DoctorDashboard/DoctorDashboard.jsx` (+ `PatientsSection`, shared `AppointmentsTable`) | `GET /dashboard`, `GET /patients?limit=6`, `GET /appointments?from=<now>&status=pending,confirmed,checked-in&limit=10` | Stats from `counters` (no more fetching 4 lists of 100 to count client-side). PatientCard: `name`, age from `birthDate`, `sex`, `acuity`, `admission.room`. Appointments table: `patientName`, `start`, `type`, `status`. QuickActions become links (add patient, schedule appointment, new prescription, reports) |
| `patient-records` | `Components/DoctorDashboard/PatientRecords.jsx` | List: `GET /patients?q=&acuity=&cursor`. Detail: `GET /patients/{id}`, `GET /patients/{id}/vitals?limit=5`, `GET /prescriptions?patientId=&status=active`, `GET /medical-records?patientId=`, `GET /appointments?patientId=`. Actions: `POST /patients`, `PATCH /patients/{id}`, `POST /patients/{id}/vitals`, `POST /medical-records`, `POST /medical-records/{id}/addenda`, `POST /patients/{id}/care-team`, admission endpoints | Rows: `name`, age, `sex`, `acuity` badge, `admission` (ward, room, bed). **Remove** the list's `lastVisit` and `nextAppointment` columns and the `PatientCard` `lastVisit` prop: computing them per row would need an appointments query per patient. Filter `acuity` (stable, moderate, high, critical) replaces the fake "active, critical, recovered". Detail panel: demographics, `phone`, `email`, `address`, `bloodType`, `allergies` (prominent), `chronicConditions`, `latestVitals`, active medications, records (with `labResults` table and `addenda`), last visit (latest `completed` appointment) and next appointment, shown **only** in the detail panel from its `GET /appointments?patientId=` call. **Remove** the trash icons (no hard deletes); doctors can set `status: inactive/deceased` in the edit form |
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
| `appointments` | `Components/PatientDashboard/UpcomingAppointmentsCard.jsx` (grows into the patient appointments page) | `GET /appointments?from=<now>` (upcoming tab), `GET /appointments?to=<now>` (past tab), `POST /appointments`, `PATCH /appointments/{id}`, `GET /practitioners?role=doctor`, `GET /practitioners/{id}/busy`, `GET /system-settings` | Booking form: doctor, date (only `appointments.openingHours.days` within `bookingWindowDays` are selectable), and candidate slots = the day's opening hours on 15-minute boundaries, minus `busy` intervals (bookings and leave), minus anything before `now + minLeadTimeMinutes`; then `durationMinutes`, `type`, `reason`. A `409 slot-unavailable` refreshes the slots. Cancel (with reason) and reschedule while `pending` or `confirmed` |
| `prescriptions` | `Components/PatientDashboard/PatientPrescriptions.jsx` | `GET /prescriptions?status=active`, `GET /prescriptions?status=completed,stopped` (history), `POST /prescriptions/{id}/refill-requests` | Fields: `medication`, `dose`, `frequency`, `instructions`, `startDate`/`endDate`, `refills`, `prescriberName`. "Request refill" is shown for current outpatient prescriptions with `refills > 0` |
| `medical-records` | `Components/PatientDashboard/MedicalRecords.jsx` | `GET /me` (patient), `GET /patients/{id}/vitals?limit=2` (trend arrows from the previous reading), `GET /prescriptions?status=active`, `GET /appointments?to=<now>&status=completed` (visits), `GET /medical-records?category=&cursor` | Header: `name`, `folderNumber` (when present), `birthDate`, `bloodType`, `allergies`, `chronicConditions` (replacing "ID: {patient.id}"). Vitals cards with the real trend. Tabs: summary, records (`title`, `category`, `effectiveAt`, `authorName`, `labResults` table, `addenda`), visits, medications. **Remove** "Add Note" and "Order Lab" (staff actions) |
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
  Every migrated document gets `schemaVersion: 2`, `updatedAt = now` and `updatedBy = "system"`. Each
  migrated document also gets an `auditEvents` entry (`actorId: "system"`, `action: "update"`,
  `changedFields` = the renamed or added fields).

| Collection | Transform |
| ---------- | --------- |
| `facilities` (new) | If none exist, create `facilities/default` `{ name: "CureCloud Demo Hospital", type: "hospital", status: "active" }` (override the name with `--default-facility-name`). This is the **fallback facility** the rows below call `default`. If facilities already exist, the fallback is the only one, or the one named by `--default-facility-id` (which must exist); with several facilities and no `--default-facility-id` the run aborts before writing |
| `users` | `phoneNumber → phone` (normalized E.164). `nationalId → identifier` (`za-id` if 13 digits passing Luhn, otherwise `other`). `specialization → practitioner.specialization` for doctors and nurses (and `practitioner.licenceBody` from role). Staff with `facilityId: null` get the fallback facility. Add `departmentId: null`, `nameLower`, `createdBy` (own UID). Admins keep `facilityId: null` (system admins); admins with a stray `practitioner` or `specialization` get it moved to `legacy`. For `role: patient`: `phone` and `emergencyContact` move to the linked patient (only where the patient field is empty) and the user copies go to `legacy` |
| `patients` | `dateOfBirth → birthDate`. `priority → acuity`. `vitals → latestVitals` (with the vitals transform below). `room` → if non-null, `admission: { departmentId: null, departmentName: "Unassigned", room, admittedAt: createdAt, admittedBy: "system" }`, otherwise `admission: null`; `admitted` is set to match. `nextMed → legacy.nextMed`. Add `status: "active"`, `sex: "unknown"`, `allergies: []`, `noKnownAllergies: false`, `chronicConditions: []`, `conditionCategories: []`, `identifier: null`, `folderNumber: null`, `facilityId` (the fallback facility if the care team is non-empty, else `null`), `nameLower`, and `email` (contact email, initialised from the linked user's sign-in email). `phone`/`emergencyContact` come from the user transform above |
| `patients/*/vitals` | `bloodPressure "120/80"` → `{ systolic: 120, diastolic: 80 }`. `bloodSugar` (mg/dL) → `bloodGlucose = round(bloodSugar / 18, 1)` mmol/L, original kept in `legacy.bloodSugar`. Add `status: "final"`, `createdBy = recordedBy`, `createdByName` (looked up), `patientId` |
| `appointments` | `scheduledAt → start`. `end = start + 30 min`, `durationMinutes: 30`. `date`, `time → legacy`. `notes → reason`. `type` map: "General Checkup" → `check-up`, "Follow-up" → `follow-up`, "Consultation" → `consultation`, anything else → `other` (original in `legacy.type`). Add `facilityId`/`departmentId` from the doctor (fallback facility otherwise) and `updatedBy`. Statuses are unchanged |
| `appointmentSlots` | Add `{ doctorId, start }` fields to existing locks. For active appointments, `create()` the second 15-minute lock (`start + 15 min`) if missing. Grandfathered appointments not on a 15-minute boundary keep their single legacy lock |
| `prescriptions` | `doctorId/doctorName → prescriberId/prescriberName`. `dosage → dose`. `notes → instructions`. `frequency` map: "Once daily" → `once-daily`, "Twice daily" → `twice-daily`, "Three times daily" → `three-times-daily`, "Four times daily" → `four-times-daily`, "As needed" → `as-needed`, "At night" → `at-night`, anything else → `custom` with `frequencyText` = the original and `administrationTimes: ["08:00"]`. Add `route: "oral"`, `category: "outpatient"`, `administrationTimes` (defaults per frequency). Status `discontinued → stopped`. Add `facilityId` from the migrated patient (`null` if none) |
| `medicalRecords` | `doctorId/doctorName → authorId/authorName`, add `authorRole: "doctor"`. `type → title`, plus `category` by keyword: "blood", "lab", "test" → `lab-result`; "x-ray", "scan", "mri", "ct" → `imaging`; otherwise `consultation`. `results → findings`. Add `effectiveAt = createdAt`, `labResults: []`, `addenda: []` |
| `notifications` | `type: "record" → "medical-record"`. Add `readAt` (`updatedAt` or `null`), `resource: null`, `expiresAt = createdAt + 90 days` |
| `patientIdentifiers` | Not present before v1 (no identifiers were stored on patients). Created by the API with the HMAC key |
| `userPreferences` | Drop `theme`, `calendarView`, `listView` to `legacy` if any document has them |
| `systemSettings`, `systemAlerts`, `departments`, `careTasks`, `shifts`, `medicationAdministrations`, `administrationSlots`, `conversations`, `auditEvents` | New and empty. No migration (defaults are applied on read) |

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
- Admin-created staff invites (`POST /users`), MFA, login history, a per-read access audit log, an
  `auditEvents` read API, and break-glass emergency access.
- Facility management (`POST`/`PATCH /facilities`) and per-facility settings such as opening hours.
  Manually raised system alerts (`POST /system-alerts`).
- Dark theme, and theme, calendar view and list view preferences.
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

- `src/authz/` (section 3) and `src/lib/problem.js` (`HttpProblem` + error handler).
- `src/lib/firestore-query.js` (executes query specs; cursor encode and decode of `[...orderByValues, id]`,
  page) and `src/lib/dates.js` (SAST helpers, slot alignment, opening hours check).
- `src/lib/route.js`: `defineRoute(router, { method, path, permission, request, responses })`, which mounts
  the handler and registers the OpenAPI operation from the same call ([1.11](#111-api-documentation-openapi--swagger)).
- `src/lib/audit.js`: `writeAudit(txOrBatch, actor, { action, resource, patientId?, changedFields })`, which
  adds an `auditEvents` document to the caller's transaction or batch and never writes on its own
  ([2.20](#220-auditevent)). `changedFields` is computed from the validated patch keys, never from values.
- `src/lib/identifiers.js`: HMAC-SHA256 of `"{type}:{value}"` with `PATIENT_IDENTIFIER_KEY`
  (`defineSecret`; `demo-identifier-key` under the emulator).
- `src/models/*.js`: zod entity, request and response schemas (one module per entity), registered in an OpenAPI registry.
- `src/routes/v1/*.js`: one router per resource. `src/openapi.js` builds the document.

Writes that touch more than one document use transactions or batches: booking with slots and care team,
vitals with `latestVitals`, discharge with history, a message with the conversation summary, and a
scheduled administration with its `administrationSlots` lock (created on chart, deleted on retract). Notifications are written inside the same transaction or batch,
as `notify()` does today.

Tests:

- `test/policy.test.js`: pure unit tests of the matrix, the relationship rules and redaction. It covers the
  null cases: `facility` and `department` are false when both sides are `null`; a patient never passes
  `facility` or channel `participant`; a facility admin does not see a patient or user with
  `facilityId: null` (except pending staff).
- Integration tests per resource against the emulators, including at least one test per denial type in
  [3.5](#35-denial-semantics) and per state machine.
- Required denial tests for account control (`PATCH /users/{id}`):
  - a facility admin cannot change their own `facilityId` (to `null` or another facility), `role` or
    `status` (`403`);
  - a facility admin cannot modify a system admin, grant `role: admin`, or clear an admin's `facilityId`
    (`403` or `404`);
  - a system admin cannot move the last active system admin to a facility (`409`), demote or disable it
    (`409`).
- Required denial tests for actor filters: a doctor calling `GET /prescriptions?prescriberId=<colleague>`
  and a nurse calling `GET /medication-administrations?performerId=<colleague>` without a clinical
  `patientId` get `403`.
- Required denial tests for patient conversations: a patient creating a `patient` conversation that
  includes another patient's account or staff not on their care team gets `403`.
- Booking outside `openingHours` and during a doctor's `leave` shift returns `409 slot-unavailable`.
- `PATCH /me` with `phone` as a patient returns `403`, and `PATCH /patients/{ownId}` with `identifier` as
  a patient returns `403`.
- Facility consistency (`test/policy.test.js` for the pure checks, plus integration tests): a facility
  admin setting a nurse's `departmentId` to another facility's department gets `400`; a system admin
  changing a user's `facilityId` without setting or clearing `departmentId` gets `400`; `PATCH
  /departments/{id}` with `facilityId` gets `400`; admitting a patient to a department of another facility
  gets `400`; adding a care team member from another facility as a doctor or facility admin gets `400`.
- Medication re-charting: chart a scheduled dose (`201`), chart it again (`409 already-charted`), retract
  it, chart it again (`201`); between the retract and the re-chart the schedule shows the dose as `due`,
  `upcoming` or `overdue`.
- Email verification: approving a pending staff account whose Firebase Auth email is unverified returns
  `409 invalid-state-transition`, and approving it after `updateUser(uid, { emailVerified: true })` in the
  Auth emulator succeeds. `POST /auth/signup` with the `BOOTSTRAP_ADMIN_EMAIL` returns `409 conflict`.
- Care tasks: a nurse in the department but without clinical access to a non-admitted patient's task gets
  `404`; `POST /care-tasks` with `patientId` and `departmentId` gets `400`.
- Shifts: a system admin calling `GET /shifts` without `facilityId`, `departmentId` or `staffId=me` gets
  `400`; an admin `PATCH /shifts/{id} { handoverNote }` gets `403`.
- An audit test: a clinician's `PATCH /patients/{id}` of `allergies` writes exactly one `auditEvents`
  document with `changedFields: ["allergies"]` and no values (patients cannot write `allergies`, see
  [3.4](#34-field-level-rules)).
- The bootstrap admin test (existing) stays.
- An OpenAPI coverage test (route list from `defineRoute` against the spec) and the index coverage test
  in [2.19](#219-index-summary).

Frontend:

- `api/client.js` is updated first, with one function per endpoint.
- Pages are migrated section by section following [5](#5-page-to-endpoint-mapping). Shared components
  ([5.9](#59-shared-ui-components-reuse-targets)) are extracted as they are touched.
- `MockData.js` is deleted last.
