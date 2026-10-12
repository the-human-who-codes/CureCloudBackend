// The /api/v1 router. Every route is registered through defineRoute (lib/route.js).
import { Router } from "express";
import { notFound } from "../../lib/problem.js";
import * as appointments from "./appointments.js";
import * as careTasks from "./careTasks.js";
import * as conversations from "./conversations.js";
import * as dashboard from "./dashboard.js";
import * as me from "./me.js";
import * as medicalRecords from "./medicalRecords.js";
import * as notifications from "./notifications.js";
import * as organisation from "./organisation.js";
import * as patients from "./patients.js";
import * as prescriptions from "./prescriptions.js";
import * as shifts from "./shifts.js";
import * as system from "./system.js";
import * as users from "./users.js";

export function v1Router() {
  const router = Router();
  // Static paths before parameterised ones (e.g. /shifts/current before /shifts/{id}).
  for (const module of [
    me,
    dashboard,
    users,
    organisation,
    patients,
    appointments,
    prescriptions,
    medicalRecords,
    careTasks,
    shifts,
    notifications,
    conversations,
    system,
  ]) {
    module.register(router);
  }
  router.use(() => {
    throw notFound("route");
  });
  return router;
}
