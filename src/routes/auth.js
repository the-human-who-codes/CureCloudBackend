import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { auth, db } from "../firebase.js";
import { badRequest, conflict, parse } from "../lib/http.js";
import { STAFF_ROLES, name, phone } from "../lib/schemas.js";

const router = Router();

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  fullName: name,
  nationalId: z.string().trim().regex(/^[A-Za-z0-9]{6,20}$/, "Invalid ID number"),
  role: z.enum(STAFF_ROLES),
  phoneNumber: phone,
});

// POST /api/auth/signup — staff self-registration. Accounts start "pending" until an admin approves.
router.post("/signup", async (req, res) => {
  const body = parse(signupSchema, req.body);

  let record;
  try {
    record = await auth.createUser({
      email: body.email,
      password: body.password,
      displayName: body.fullName,
    });
  } catch (err) {
    if (err.code === "auth/email-already-exists") {
      throw conflict("An account with this email already exists");
    }
    if (err.code === "auth/invalid-password") throw badRequest(err.message);
    throw err;
  }

  try {
    await db.collection("users").doc(record.uid).create({
      name: body.fullName,
      email: body.email,
      role: body.role,
      status: "pending",
      phoneNumber: body.phoneNumber,
      nationalId: body.nationalId,
      facilityId: null,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    await auth.deleteUser(record.uid).catch(() => {});
    throw err;
  }

  res.status(201).json({
    id: record.uid,
    status: "pending",
    message: "Account created. An administrator must approve it before you can sign in.",
  });
});

export default router;
