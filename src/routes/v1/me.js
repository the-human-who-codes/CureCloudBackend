// Staff signup, the caller's own profile and preferences (docs/domain-model.md §4.2 "Public", "Me").
import { auth, db } from "../../firebase.js";
import { ownPatient, permissionsFor, redact } from "../../authz/index.js";
import { writeAudit } from "../../lib/audit.js";
import { conflict, fieldForbidden, notFound, problem } from "../../lib/problem.js";
import { defineRoute } from "../../lib/route.js";
import { serialize, toJson } from "../../lib/serialize.js";
import { createdFields, nameLower, sendCreated, updatedFields } from "../../lib/write.js";
import { newPatientDoc } from "./patients.js";
import {
  DEFAULT_PREFERENCES,
  LICENCE_BODIES,
  MeCreateRequest,
  MeResponse,
  MeUpdateRequest,
  PreferencesUpdateRequest,
  SignupRequest,
  SignupResponse,
  UserPreferences,
} from "../../models/index.js";
import { deepMerge } from "../../lib/settings.js";

const isBootstrapEmail = (email) => {
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  return Boolean(adminEmail && email?.trim().toLowerCase() === adminEmail);
};
const isBootstrapAdmin = ({ email, emailVerified }) => emailVerified && isBootstrapEmail(email);

async function meBody(user) {
  const patient = user.role === "patient" ? await ownPatient(user) : null;
  return {
    user: redact(user, "user", toJson(user)),
    patient: patient ? redact(user, "patient", toJson(patient), { access: "self" }) : null,
    permissions: permissionsFor(user),
  };
}

const reloadUser = async (uid) => {
  const snap = await db.collection("users").doc(uid).get();
  return { id: snap.id, ...snap.data() };
};

export function register(router) {
  defineRoute(router, {
    method: "post",
    path: "/auth/signup",
    permission: "public",
    summary: "Staff self-registration (account starts pending)",
    tags: ["Me"],
    request: { body: SignupRequest },
    responses: { 201: SignupResponse },
    problems: ["409"],
    async handler(req, res) {
      const body = req.valid.body;
      // Nobody may pre-register the bootstrap admin's address as a pending staff account.
      if (isBootstrapEmail(body.email)) throw conflict("This email cannot be used for staff sign-up");
      let record;
      try {
        record = await auth.createUser({ email: body.email, password: body.password, displayName: body.name });
      } catch (err) {
        if (err.code === "auth/email-already-exists") throw conflict("An account with this email already exists");
        if (err.code === "auth/invalid-password") throw problem("validation-error", "Password is too weak");
        throw err;
      }
      const actor = { id: record.uid, role: body.role };
      try {
        const batch = db.batch();
        batch.create(db.collection("users").doc(record.uid), {
          email: body.email,
          name: body.name,
          nameLower: nameLower(body.name),
          phone: body.phone,
          role: body.role,
          status: "pending",
          statusReason: null,
          facilityId: null,
          departmentId: null,
          identifier: body.identifier,
          emergencyContact: null,
          practitioner: {
            licenceBody: LICENCE_BODIES[body.role],
            licenceNumber: body.licenceNumber ?? null,
            specialization: body.specialization ?? null,
            qualifications: [],
          },
          ...createdFields(actor),
        });
        batch.set(db.collection("systemAlerts").doc(), {
          title: `New ${body.role} signup awaiting approval`,
          message: `${body.name} signed up as a ${body.role} and needs a facility and approval.`,
          severity: "info",
          status: "active",
          source: "system",
          facilityId: null,
          resource: { type: "user", id: record.uid },
          resolvedAt: null,
          resolvedBy: null,
          ...createdFields(null),
        });
        writeAudit(batch, actor, {
          action: "create",
          resource: { type: "user", id: record.uid },
          changedFields: ["role", "status", "facilityId", "departmentId", "practitioner"],
        });
        await batch.commit();
      } catch (err) {
        await auth.deleteUser(record.uid).catch(() => {});
        throw err;
      }
      sendCreated(res, `/users/${record.uid}`, { id: record.uid, status: "pending" });
    },
  });

  defineRoute(router, {
    method: "get",
    path: "/me",
    permission: "signed-in",
    summary: "The caller's account, patient record and permissions",
    description: "404 not-found means the caller is signed in but has no profile yet (call POST /me).",
    tags: ["Me"],
    responses: { 200: MeResponse },
    problems: ["404"],
    async handler(req, res) {
      if (!req.user) throw notFound("profile");
      res.json(await meBody(req.user));
    },
  });

  defineRoute(router, {
    method: "post",
    path: "/me",
    permission: "signed-in",
    summary: "Create the caller's profile after the first Google sign-in",
    description:
      "Creates a patient account and patient record. A verified email matching BOOTSTRAP_ADMIN_EMAIL creates the first system admin instead.",
    tags: ["Me"],
    request: { body: MeCreateRequest },
    responses: { 201: MeResponse },
    problems: ["409"],
    async handler(req, res) {
      if (req.user) throw conflict("Profile already exists");
      const body = req.valid.body;
      const name = body.name ?? req.auth.name;
      if (!name || name.trim().length < 2) {
        throw problem("validation-error", "1 field is invalid", {
          errors: [{ path: "name", message: "name is required", code: "invalid_type" }],
        });
      }
      const uid = req.auth.uid;
      const admin = isBootstrapAdmin(req.auth);
      const actor = { id: uid, role: admin ? "admin" : "patient" };
      const batch = db.batch();
      batch.create(db.collection("users").doc(uid), {
        email: req.auth.email,
        name: name.trim(),
        nameLower: nameLower(name),
        phone: admin ? (body.phone ?? null) : null,
        photoUrl: req.auth.picture ?? null,
        role: actor.role,
        status: "active",
        statusReason: null,
        facilityId: null,
        departmentId: null,
        identifier: null,
        emergencyContact: null,
        practitioner: null,
        ...createdFields(actor),
      });
      if (!admin) {
        batch.create(
          db.collection("patients").doc(uid),
          newPatientDoc(actor, {
            userId: uid,
            facilityId: null,
            name: name.trim(),
            phone: body.phone ?? null,
            email: req.auth.email,
            birthDate: body.birthDate ?? null,
            sex: body.sex ?? "unknown",
          }),
        );
        writeAudit(batch, actor, {
          action: "create",
          resource: { type: "patient", id: uid },
          patientId: uid,
          changedFields: ["name", "phone", "email", "birthDate", "sex"],
        });
      }
      writeAudit(batch, actor, { action: "create", resource: { type: "user", id: uid }, changedFields: ["role", "status"] });
      try {
        await batch.commit();
      } catch (err) {
        if (err.code === 6) throw conflict("Profile already exists"); // ALREADY_EXISTS race
        throw err;
      }
      sendCreated(res, "/me", await meBody(await reloadUser(uid)));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/me",
    permission: "profile:update",
    summary: "Update the caller's own profile",
    description:
      "Patients may only change name here; their contact data lives on the Patient (PATCH /patients/{id}).",
    tags: ["Me"],
    request: { body: MeUpdateRequest },
    responses: { 200: MeResponse },
    async handler(req, res) {
      const body = req.valid.body;
      const user = req.user;
      if (user.role === "patient") {
        const denied = Object.keys(body).find((k) => !["name", "givenName", "familyName"].includes(k));
        if (denied) throw fieldForbidden(denied);
      }
      if (body.practitioner && !user.practitioner) throw fieldForbidden("practitioner");

      const update = { ...updatedFields(user) };
      for (const key of ["name", "givenName", "familyName", "phone", "emergencyContact"]) {
        if (body[key] !== undefined) update[key] = body[key];
      }
      if (body.name) update.nameLower = nameLower(body.name);
      for (const [key, value] of Object.entries(body.practitioner ?? {})) update[`practitioner.${key}`] = value;

      const batch = db.batch();
      batch.update(db.collection("users").doc(user.id), update);
      if (user.role === "patient" && (body.name || body.givenName !== undefined || body.familyName !== undefined)) {
        const patient = await ownPatient(user);
        if (patient) {
          const mirrored = {};
          for (const key of ["name", "givenName", "familyName"]) if (body[key] !== undefined) mirrored[key] = body[key];
          if (body.name) mirrored.nameLower = nameLower(body.name);
          batch.update(db.collection("patients").doc(patient.id), { ...mirrored, ...updatedFields(user) });
          writeAudit(batch, user, {
            action: "update",
            resource: { type: "patient", id: patient.id },
            patientId: patient.id,
            changedFields: Object.keys(mirrored).filter((k) => k !== "nameLower"),
          });
        }
      }
      await batch.commit();
      res.json(await meBody(await reloadUser(user.id)));
    },
  });

  const prefsRef = (uid) => db.collection("userPreferences").doc(uid);
  const prefsBody = (snap) => {
    const stored = snap.exists ? serialize(snap) : {};
    return {
      notifications: { ...DEFAULT_PREFERENCES.notifications, ...stored.notifications },
      language: stored.language ?? DEFAULT_PREFERENCES.language,
      timeZone: stored.timeZone ?? DEFAULT_PREFERENCES.timeZone,
      updatedAt: stored.updatedAt ?? null,
    };
  };

  defineRoute(router, {
    method: "get",
    path: "/me/preferences",
    permission: "preferences:read",
    summary: "The caller's preferences, with defaults filled in",
    tags: ["Me"],
    responses: { 200: UserPreferences },
    async handler(req, res) {
      res.json(prefsBody(await prefsRef(req.user.id).get()));
    },
  });

  defineRoute(router, {
    method: "patch",
    path: "/me/preferences",
    permission: "preferences:update",
    summary: "Update the caller's preferences (deep merge)",
    tags: ["Me"],
    request: { body: PreferencesUpdateRequest },
    responses: { 200: UserPreferences },
    async handler(req, res) {
      const ref = prefsRef(req.user.id);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists ? snap.data() : {};
        const { legacy, ...rest } = current;
        const merged = deepMerge(
          { notifications: { ...DEFAULT_PREFERENCES.notifications, ...rest.notifications } },
          req.valid.body,
        );
        tx.set(
          ref,
          {
            ...(legacy && { legacy }),
            notifications: merged.notifications,
            language: merged.language ?? rest.language ?? DEFAULT_PREFERENCES.language,
            timeZone: merged.timeZone ?? rest.timeZone ?? DEFAULT_PREFERENCES.timeZone,
            schemaVersion: 2,
            ...updatedFields(req.user),
          },
        );
      });
      res.json(prefsBody(await ref.get()));
    },
  });
}
