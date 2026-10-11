# CureCloud Backend

REST API for [CureCloud](https://github.com/the-human-who-codes/CureCloud), a health management system for
public hospitals. Express on a single Cloud Function (`api`) with Firestore, deployed to the `curecloud1`
Firebase project.

The frontend's Firebase Hosting config rewrites `/api/**` to this function, so the browser calls same-origin
`/api/...` with `Authorization: Bearer <Firebase ID token>`. All Firestore access goes through this API;
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

Requires the Blaze plan (Cloud Functions). Deploy the API before any frontend deploy that relies on the
`/api/**` rewrite.

## Roles & access

| Role    | How they get it                                                       | Sees                                       |
| ------- | --------------------------------------------------------------------- | ------------------------------------------ |
| patient | First Google sign-in → `POST /api/me`                                 | Only their own data                        |
| doctor  | `POST /api/auth/signup` → admin approves                              | Patients on their care team                |
| nurse   | `POST /api/auth/signup` → admin approves                              | Patients on their care team                |
| admin   | `POST /api/me` with a verified email matching `BOOTSTRAP_ADMIN_EMAIL` | Everything; manages users and care teams   |

Booking an appointment adds the doctor to the patient's care team. Inaccessible patients return 404.

## Endpoints

All under `/api`. List endpoints accept `?limit=` (default 50, max 100).

| Method | Path                            | Who                        | Notes                                                              |
| ------ | ------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| GET    | `/health`                       | public                     |                                                                    |
| POST   | `/auth/signup`                  | public                     | Staff signup (matches `StaffSignUp.jsx`); account starts `pending` |
| GET    | `/me`                           | signed in                  | 404 = needs onboarding. Patients also get `patient` (vitals etc.)  |
| POST   | `/me`                           | signed in, no profile      | `{ name?, phoneNumber?, dateOfBirth? }`                            |
| PATCH  | `/me`                           | any                        | `{ name?, phoneNumber? }`                                          |
| GET    | `/doctors`                      | any                        | Booking directory                                                  |
| GET    | `/users?role=&status=`          | admin                      |                                                                    |
| PATCH  | `/users/:id`                    | admin                      | `{ role?, status?, facilityId?, specialization? }`                 |
| GET    | `/patients`                     | doctor, nurse, admin       |                                                                    |
| POST   | `/patients`                     | doctor, nurse, admin       | Walk-in patient without an account                                 |
| GET    | `/patients/:id`                 | with access                |                                                                    |
| PATCH  | `/patients/:id`                 | doctor, nurse, admin       | `{ room?, priority?, nextMed? }`; `careTeam` admin-only            |
| GET    | `/patients/:id/vitals`          | with access                | History, newest first                                              |
| POST   | `/patients/:id/vitals`          | doctor, nurse              | `{ bloodPressure, heartRate, weight, bloodSugar, temperature, oxygenSaturation }` (any subset) |
| GET    | `/appointments?patientId=&upcoming=true` | any               | Patients: own; doctors: own schedule; nurses: `patientId` required |
| POST   | `/appointments`                 | any                        | `{ doctorId, date: YYYY-MM-DD, time: HH:mm, type?, notes?, patientId? (staff) }`; 409 if slot taken |
| PATCH  | `/appointments/:id`             | patient, doctor, admin     | `{ status?, date?+time?, type?, notes? }`; patients may only cancel/reschedule |
| GET    | `/prescriptions?patientId=&status=` | any                    | Doctors without `patientId` get ones they wrote                    |
| POST   | `/prescriptions`                | doctor                     | `{ patientId, medication, dosage, frequency, startDate, endDate?, refills?, notes? }` |
| PATCH  | `/prescriptions/:id`            | prescribing doctor, admin  | `{ status?, refills?, endDate?, notes? }`                          |
| GET    | `/medical-records?patientId=`   | any                        |                                                                    |
| POST   | `/medical-records`              | doctor                     | `{ patientId, type, diagnosis?, treatment?, results?, recommendations?, appointmentId?, status? }` |
| PATCH  | `/medical-records/:id`          | author                     | Only while `preliminary`; `final` records are immutable            |
| GET    | `/notifications?unread=true`    | any                        | Own notifications                                                  |
| PATCH  | `/notifications/:id/read`       | owner                      |                                                                    |
| POST   | `/notifications/read-all`       | any                        |                                                                    |
| GET    | `/admin/stats`                  | admin                      | `{ totalDoctors, totalNurses, totalPatients, pendingStaff, activeAppointments }` |

Enums are lowercase: priority `stable|moderate|high|critical`, appointment status
`pending|confirmed|cancelled|completed`, prescription status `active|completed|discontinued`.
Times are SAST (UTC+2).

The frontend wrapper in CureCloud's `client/src/api/client.js` exposes each endpoint as a function.
