import { Timestamp } from "firebase-admin/firestore";

// CureCloud targets South African facilities (SAST, UTC+2, no DST).
const UTC_OFFSET = "+02:00";

export const toScheduledAt = (date, time) => {
  const d = new Date(`${date}T${time}:00${UTC_OFFSET}`);
  if (Number.isNaN(d.getTime())) return null;
  return Timestamp.fromDate(d);
};
