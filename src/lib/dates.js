// Time helpers (docs/domain-model.md §1.2). Business rules that depend on "today" are evaluated in
// Africa/Johannesburg (SAST, UTC+2, no DST), so a fixed offset is exact.
import { Timestamp } from "firebase-admin/firestore";

export const TIME_ZONE = "Africa/Johannesburg";
const OFFSET_MS = 2 * 3600e3;
export const MINUTE = 60e3;
export const HOUR = 3600e3;
export const DAY = 86400e3;

// Wall-clock parts of an instant in SAST.
export function sastParts(date) {
  const shifted = new Date(date.getTime() + OFFSET_MS).toISOString();
  const weekday = new Date(date.getTime() + OFFSET_MS).getUTCDay() || 7; // ISO: 1 = Monday … 7 = Sunday
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16), hour: Number(shifted.slice(11, 13)), weekday };
}

export const sastDate = (date = new Date()) => sastParts(date).date;

// "2026-10-12" + "08:00" (SAST) → Date.
export const sastInstant = (dateString, time = "00:00") => new Date(`${dateString}T${time}:00+02:00`);

export const startOfSastDay = (date = new Date()) => sastInstant(sastDate(date));
export const addMs = (date, ms) => new Date(date.getTime() + ms);

export const isoWeekday = (dateString) => sastParts(sastInstant(dateString, "12:00")).weekday;

// Start times are aligned to 15-minute boundaries (SAST is a whole-hour offset, so UTC alignment is equivalent).
export const isQuarterHour = (date) => date.getTime() % (15 * MINUTE) === 0;

// Whether [start, end) lies inside the opening hours on an allowed weekday, in SAST.
export function withinOpeningHours(start, end, { start: open, end: close, days }) {
  const s = sastParts(start);
  const lastMinute = sastParts(addMs(end, -1));
  if (s.date !== lastMinute.date || !days.includes(s.weekday)) return false;
  const endTime = sastParts(end).date === s.date ? sastParts(end).time : "24:00";
  return s.time >= open && endTime <= close;
}

export const toDate = (v) => {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  return new Date(v);
};
export const toTimestamp = (v) => (v ? Timestamp.fromDate(toDate(v)) : null);

// Merges overlapping or touching intervals ({ start: Date, end: Date }).
export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = new Date(Math.max(last.end, i.end));
    else out.push({ start: new Date(i.start), end: new Date(i.end) });
  }
  return out;
}
