# CureCloud Backend

REST API for [CureCloud](https://github.com/the-human-who-codes/CureCloud), a health management system for
public hospitals. Express on a single Cloud Function (`api`) with Firestore, deployed to the `curecloud1`
Firebase project.

The function runs in `africa-south1` next to Firestore. Firebase Hosting rewrites don't support that region, so
the frontend calls the function URL directly (`https://africa-south1-curecloud1.cloudfunctions.net/api/api/...`)
with `Authorization: Bearer <Firebase ID token>`. CORS (`src/middleware/cors.js`) allows only the live site,
Hosting preview channels and localhost. All Firestore access goes through this API;
`firestore.rules` denies direct client access.

## Local development

Requires Node 22 (`mise.toml`) and Java 11+ for the Firestore emulator.

```sh
npm install
cp .env.example .env            # set BOOTSTRAP_ADMIN_EMAIL
npm run serve                   # auth, firestore, functions emulators (UI on :4000)

# in the CureCloud repo
cd client && npm run dev:emulator   # Vite proxies /api to the functions emulator
# sign in with Google (emulator popup), then back here:
npm run seed -- you@example.com doctor
```

`npm test` runs the integration suite against throwaway emulators (`demo-curecloud` project).

## Deploy

```sh
npx firebase login
npm run deploy                  # functions + Firestore rules/indexes
```

Requires the Blaze plan (Cloud Functions).

## CI/CD

`.github/workflows/test.yml` runs the emulator test suite on every PR and push to `main`. After tests pass on
`main` it deploys functions + Firestore rules/indexes to `curecloud1`.

Deploy setup (one-off):

1. In Google Cloud console → IAM → Service accounts (project `curecloud1`), create `github-deployer` with roles:
   Firebase Admin, Cloud Functions Admin, Service Account User, Artifact Registry Administrator.
   Create a JSON key.
2. GitHub repo → Settings → Secrets → Actions: add `FIREBASE_SERVICE_ACCOUNT_CURECLOUD1` (the JSON key).
3. Settings → Variables → Actions: add `BOOTSTRAP_ADMIN_EMAIL`.
4. Settings → Environments: create `production` (optionally require approval).

Until the secret exists, the deploy job is skipped and only tests run.

## Data model

[`docs/domain-model.md`](docs/domain-model.md) is the contract: entity shapes, the authorization model, the
`/api/v1` endpoints and the page-to-endpoint mapping. The zod schemas in `src/models/` (one module per entity:
stored document, requests, response) implement it, and `src/authz/` holds every authorization decision
(role-to-permission matrix, relationship rules, field redaction and scoped list queries).

Stored documents carry `schemaVersion: 2`. Older documents are upgraded by the idempotent migration, which only
runs against the emulator unless a project is named and confirmed:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run migrate             # dry run: counts and sample diffs (IDs only)
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run migrate -- --apply
npm run migrate -- --project <id> --confirm <id> [--apply]          # owner only; deploy indexes first
```

## Roles & access

| Role    | How they get it                                                       | Sees                                                     |
| ------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| patient | First Google sign-in → `POST /api/v1/me`                              | Their own record, care team conversations                |
| doctor  | `POST /api/v1/auth/signup` → verify email → admin approves            | Patients on their care team (clinical access)            |
| nurse   | `POST /api/v1/auth/signup` → verify email → admin approves            | Care team patients plus patients admitted to their ward  |
| admin   | System admin: `POST /api/v1/me` with a verified `BOOTSTRAP_ADMIN_EMAIL`. Facility admin: promoted by a system admin | Accounts, organisation, scheduling and demographics of their facility (system admins: all). No clinical content |

Booking an appointment adds the doctor to the patient's care team. A resource the caller has no relationship
to returns 404; a visible resource with a forbidden action or field returns 403. `GET /api/v1/me` returns the
caller's `permissions`.

## API documentation

- **Swagger UI:** `GET /api/docs` (locally `http://127.0.0.1:5001/curecloud1/africa-south1/api/api/docs` under
  `npm run serve`). Authorize with a Firebase ID token (`await auth.currentUser.getIdToken()` in the client)
  to try requests.
- **OpenAPI 3.1 document:** `GET /api/openapi.json`, also committed as [`docs/openapi.json`](docs/openapi.json).
- **Contract:** [`docs/domain-model.md`](docs/domain-model.md) for entity shapes, the authorization model and the
  page-to-endpoint mapping.

The document is generated from the zod models in `src/models/` and the `defineRoute` calls in `src/routes/v1/`
(`src/openapi.js`); there is no hand-written spec. Each operation lists its required permission, parameters,
request body, responses and problem+json errors. After changing a route or model, run `npm run openapi` and commit
`docs/openapi.json`; `npm test` fails if it is out of date or if any route is undocumented.

The frontend wrapper in CureCloud's `client/src/api/client.js` exposes each endpoint as a function.
