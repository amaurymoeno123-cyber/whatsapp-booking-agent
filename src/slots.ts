export type Range = { start: string; end: string };

const DAY_MINUTES = 24 * 60;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = typeof DAY_KEYS[number];

/** "09:30" -> 570. "24:00" and "00:00" as an end time both mean end of day. */
export function toMinutes(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) throw new Error(`invalid time: ${hhmm}`);
  const [h, m] = [Number(match[1]), Number(match[2])];
  if (h > 24 || m > 59 || (h === 24 && m > 0)) throw new Error(`invalid time: ${hhmm}`);
  return h * 60 + m;
}

export function toHHMM(minutes: number): string {
  if (minutes >= DAY_MINUTES) return "24:00";
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function endMinutes(hhmm: string): number {
  const m = toMinutes(hhmm);
  return m === 0 ? DAY_MINUTES : m;
}

/**
 * Free ranges of a day given the busy ones, already computed.
 *
 * The first version handed the model only the busy ranges and let it subtract them.
 * Asked "what's free?" five times in a row, it never answered correctly. Arithmetic
 * belongs in code, not in the prompt.
 */
export function freeSlots(busy: Range[], fromMinute = 0): Range[] {
  const sorted = busy
    .map((r) => ({ a: toMinutes(r.start), b: endMinutes(r.end) }))
    .sort((x, y) => x.a - y.a);
  const free: Range[] = [];
  let cursor = fromMinute;
  for (const { a, b } of sorted) {
    if (a > cursor) free.push({ start: toHHMM(cursor), end: toHHMM(a) });
    cursor = Math.max(cursor, b);
  }
  if (cursor < DAY_MINUTES) free.push({ start: toHHMM(cursor), end: toHHMM(DAY_MINUTES) });
  return free;
}

export function overlaps(x: Range, y: Range): boolean {
  return toMinutes(x.start) < endMinutes(y.end) && toMinutes(y.start) < endMinutes(x.end);
}

export type DateCheck =
  | { ok: true; day: DayKey }
  | { ok: false; reason: "invalid_date" | "past_date" | "too_far" | "closed" };

/** Validates a requested ISO date against "today" in the business's time zone. */
export function checkDate(
  dateIso: string,
  todayIso: string,
  opts: { maxDaysAhead: number; openDays: DayKey[] },
): DateCheck {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso) || Number.isNaN(Date.parse(dateIso))) {
    return { ok: false, reason: "invalid_date" };
  }
  if (dateIso < todayIso) return { ok: false, reason: "past_date" };
  const days = (Date.parse(dateIso) - Date.parse(todayIso)) / 86_400_000;
  if (days > opts.maxDaysAhead) return { ok: false, reason: "too_far" };
  const day = DAY_KEYS[new Date(dateIso + "T12:00:00Z").getUTCDay()];
  if (!opts.openDays.includes(day)) return { ok: false, reason: "closed" };
  return { ok: true, day };
}

export type RangeCheck = { ok: true } | { ok: false; reason: "invalid_range" };

export function checkRange(r: Range): RangeCheck {
  try {
    return toMinutes(r.start) < endMinutes(r.end)
      ? { ok: true }
      : { ok: false, reason: "invalid_range" };
  } catch {
    return { ok: false, reason: "invalid_range" };
  }
}

/** Local wall-clock date for a fixed UTC offset (Colombia has no DST: -5). */
export function localNow(now: Date, utcOffsetHours: number): Date {
  return new Date(now.getTime() + utcOffsetHours * 3_600_000);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
