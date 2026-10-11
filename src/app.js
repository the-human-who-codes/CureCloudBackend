import express from "express";
import { errorHandler } from "./lib/http.js";
import { authenticate } from "./middleware/auth.js";
import adminRoutes from "./routes/admin.js";
import appointmentRoutes from "./routes/appointments.js";
import authRoutes from "./routes/auth.js";
import meRoutes from "./routes/me.js";
import medicalRecordRoutes from "./routes/medicalRecords.js";
import notificationRoutes from "./routes/notifications.js";
import patientRoutes from "./routes/patients.js";
import prescriptionRoutes from "./routes/prescriptions.js";
import userRoutes, { doctorsRouter } from "./routes/users.js";

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
// Health data must never be cached by the Hosting CDN or browsers.
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const api = express.Router();

// Public
api.get("/health", (_req, res) => res.json({ status: "ok" }));
api.use("/auth", authRoutes);

// Everything below requires a Firebase ID token
api.use(authenticate);
api.use("/me", meRoutes);
api.use("/users", userRoutes);
api.use("/doctors", doctorsRouter);
api.use("/patients", patientRoutes);
api.use("/appointments", appointmentRoutes);
api.use("/prescriptions", prescriptionRoutes);
api.use("/medical-records", medicalRecordRoutes);
api.use("/notifications", notificationRoutes);
api.use("/admin", adminRoutes);
api.use((_req, res) => res.status(404).json({ message: "Not found" }));

app.use("/api", api);
app.use(errorHandler);
