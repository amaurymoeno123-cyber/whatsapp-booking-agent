import type { ToolHandler, ToolSpec } from "./agent.ts";
import { checkDate, checkRange, type DayKey, freeSlots, type Range } from "./slots.ts";

export type Booking = Range & { date: string; status: "pending" | "confirmed" };

/** Storage the tools need. Supabase in production, in-memory in tests. */
export interface BookingRepo {
  busyRanges(date: string): Promise<(Range & { contactId: string })[]>;
  upcomingFor(contactId: string, fromDate: string): Promise<Booking[]>;
  /** Must reject overlaps atomically (the SQL version uses an exclusion constraint). */
  requestBooking(
    contactId: string,
    date: string,
    range: Range,
  ): Promise<{ ok: true } | { ok: false; reason: "slot_taken" }>;
  cancelBooking(contactId: string, date: string, start: string): Promise<boolean>;
  registerGap(
    topic: string,
    question: string,
    phone: string,
  ): Promise<{ askAdmin: string | null }>;
}

export type ToolContext = {
  contactId: string | null;
  phone: string;
  todayIso: string;
  nowMinute: number;
  openDays: DayKey[];
  maxDaysAhead: number;
  /** Sends the pending question to an admin (WhatsApp, Telegram...). */
  askAdmin: (adminPhone: string, topic: string, question: string) => Promise<void>;
};

export const TOOL_SPECS: ToolSpec[] = [
  spec(
    "check_availability",
    "Lists FREE time ranges for a date (YYYY-MM-DD). Returns `free` (already computed, offer these), `mine` (this customer's own bookings) and `taken_by_others`. Call before offering or confirming a time.",
    { date: { type: "string", description: "YYYY-MM-DD" } },
    ["date"],
  ),
  spec(
    "request_booking",
    "Requests a booking for a time RANGE. It stays pending until staff approves it. Only for registered customers, after checking availability.",
    {
      date: { type: "string", description: "YYYY-MM-DD" },
      start: { type: "string", description: "HH:MM" },
      end: { type: "string", description: "HH:MM, later than start, same day" },
    },
    ["date", "start", "end"],
  ),
  spec(
    "cancel_booking",
    "Cancels one of this customer's bookings. Only when they clearly ask for it.",
    {
      date: { type: "string", description: "YYYY-MM-DD" },
      start: { type: "string", description: "HH:MM start of the booking to cancel" },
    },
    ["date", "start"],
  ),
  spec(
    "unknown_answer",
    "Call when someone asks a real business question you cannot answer with your information. The team receives it and teaches you the answer. Not for greetings or small talk.",
    {
      topic: { type: "string", description: "2-4 words, lowercase, e.g. 'parking'" },
      question: { type: "string", description: "the question as the person wrote it" },
    },
    ["topic", "question"],
  ),
];

export function createHandlers(repo: BookingRepo, ctx: ToolContext): Record<string, ToolHandler> {
  const dateCheck = (date: string) =>
    checkDate(date, ctx.todayIso, { maxDaysAhead: ctx.maxDaysAhead, openDays: ctx.openDays });

  return {
    async check_availability(args) {
      const date = String(args.date ?? "");
      const check = dateCheck(date);
      if (!check.ok) return { ok: false, reason: check.reason };
      const busy = await repo.busyRanges(date);
      const fromMinute = date === ctx.todayIso ? ctx.nowMinute : 0;
      return {
        ok: true,
        date,
        free: freeSlots(busy, fromMinute),
        mine: busy.filter((b) => b.contactId === ctx.contactId).map(({ start, end }) => ({
          start,
          end,
        })),
        taken_by_others: busy.filter((b) => b.contactId !== ctx.contactId).length,
      };
    },

    async request_booking(args) {
      if (!ctx.contactId) return { ok: false, reason: "not_registered" };
      const date = String(args.date ?? "");
      const range = { start: String(args.start ?? ""), end: String(args.end ?? "") };
      const check = dateCheck(date);
      if (!check.ok) return { ok: false, reason: check.reason };
      if (!checkRange(range).ok) return { ok: false, reason: "invalid_range" };
      const result = await repo.requestBooking(ctx.contactId, date, range);
      return result.ok ? { ok: true, status: "pending_approval", date, ...range } : result;
    },

    async cancel_booking(args) {
      if (!ctx.contactId) return { ok: false, reason: "not_registered" };
      const done = await repo.cancelBooking(
        ctx.contactId,
        String(args.date ?? ""),
        String(args.start ?? ""),
      );
      return done ? { ok: true } : { ok: false, reason: "not_found" };
    },

    async unknown_answer(args) {
      const topic = String(args.topic ?? "").trim().toLowerCase();
      const question = String(args.question ?? "").trim();
      if (!topic) return { ok: false, reason: "missing_topic" };
      const { askAdmin } = await repo.registerGap(topic, question, ctx.phone);
      if (askAdmin) await ctx.askAdmin(askAdmin, topic, question);
      // The model only needs to know it was logged; it should tell the customer
      // someone will get back to them, never invent an answer.
      return { ok: true, logged: true };
    },
  };
}

function spec(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolSpec {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  };
}
