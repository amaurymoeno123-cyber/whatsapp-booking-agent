import { assertEquals } from "@std/assert";
import { type Booking, type BookingRepo, createHandlers, type ToolContext } from "../src/tools.ts";
import { overlaps, type Range } from "../src/slots.ts";

type Row = Range & { contactId: string; date: string; cancelled?: boolean };

function memoryRepo(rows: Row[] = []): BookingRepo {
  const gaps: string[] = [];
  const live = () => rows.filter((r) => !r.cancelled);
  return {
    busyRanges: (date) => Promise.resolve(live().filter((r) => r.date === date)),
    upcomingFor: (contactId, from) =>
      Promise.resolve(
        live().filter((r) => r.contactId === contactId && r.date >= from)
          .map((r): Booking => ({ ...r, status: "pending" })),
      ),
    requestBooking(contactId, date, range) {
      if (live().some((r) => r.date === date && overlaps(r, range))) {
        return Promise.resolve({ ok: false, reason: "slot_taken" } as const);
      }
      rows.push({ contactId, date, ...range });
      return Promise.resolve({ ok: true } as const);
    },
    cancelBooking(contactId, date, start) {
      const row = live().find((r) =>
        r.contactId === contactId && r.date === date && r.start === start
      );
      if (row) row.cancelled = true;
      return Promise.resolve(Boolean(row));
    },
    registerGap(topic) {
      const first = !gaps.includes(topic);
      gaps.push(topic);
      return Promise.resolve({ askAdmin: first ? "admin-phone" : null });
    },
  };
}

function context(overrides: Partial<ToolContext> = {}): ToolContext & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    contactId: "me",
    phone: "57300",
    todayIso: "2030-01-07",
    nowMinute: 10 * 60,
    openDays: ["mon", "tue", "wed", "thu", "fri", "sat"],
    maxDaysAhead: 30,
    askAdmin: (admin, topic) => {
      asked.push(`${admin}:${topic}`);
      return Promise.resolve();
    },
    ...overrides,
  };
}

Deno.test("availability returns computed free slots and separates the customer's own", async () => {
  const repo = memoryRepo([
    { contactId: "me", date: "2030-01-08", start: "09:00", end: "11:00" },
    { contactId: "other", date: "2030-01-08", start: "14:00", end: "16:00" },
  ]);
  const result = await createHandlers(repo, context()).check_availability({ date: "2030-01-08" });
  assertEquals(result, {
    ok: true,
    date: "2030-01-08",
    free: [
      { start: "00:00", end: "09:00" },
      { start: "11:00", end: "14:00" },
      { start: "16:00", end: "24:00" },
    ],
    mine: [{ start: "09:00", end: "11:00" }],
    taken_by_others: 1,
  });
});

Deno.test("availability for today starts at the current time", async () => {
  const handlers = createHandlers(memoryRepo(), context());
  const result = await handlers.check_availability({ date: "2030-01-07" });
  assertEquals(result.free, [{ start: "10:00", end: "24:00" }]);
});

Deno.test("availability rejects closed days before touching the database", async () => {
  const handlers = createHandlers(memoryRepo(), context());
  assertEquals(await handlers.check_availability({ date: "2030-01-13" }), {
    ok: false,
    reason: "closed",
  });
});

Deno.test("unregistered customers cannot book or cancel", async () => {
  const handlers = createHandlers(memoryRepo(), context({ contactId: null }));
  const notRegistered = { ok: false, reason: "not_registered" };
  assertEquals(
    await handlers.request_booking({ date: "2030-01-08", start: "09:00", end: "10:00" }),
    notRegistered,
  );
  assertEquals(
    await handlers.cancel_booking({ date: "2030-01-08", start: "09:00" }),
    notRegistered,
  );
});

Deno.test("booking validates the range and surfaces conflicts", async () => {
  const repo = memoryRepo([{
    contactId: "other",
    date: "2030-01-08",
    start: "09:00",
    end: "12:00",
  }]);
  const handlers = createHandlers(repo, context());
  const book = (start: string, end: string) =>
    handlers.request_booking({ date: "2030-01-08", start, end });

  assertEquals(await book("12:00", "09:00"), { ok: false, reason: "invalid_range" });
  assertEquals(await book("11:00", "13:00"), { ok: false, reason: "slot_taken" });
  assertEquals(await book("12:00", "13:00"), {
    ok: true,
    status: "pending_approval",
    date: "2030-01-08",
    start: "12:00",
    end: "13:00",
  });
});

Deno.test("cancel only finds the customer's own booking", async () => {
  const repo = memoryRepo([{
    contactId: "other",
    date: "2030-01-08",
    start: "09:00",
    end: "12:00",
  }]);
  const handlers = createHandlers(repo, context());
  assertEquals(await handlers.cancel_booking({ date: "2030-01-08", start: "09:00" }), {
    ok: false,
    reason: "not_found",
  });
});

Deno.test("an unknown answer asks the admin only the first time", async () => {
  const ctx = context();
  const handlers = createHandlers(memoryRepo(), ctx);
  await handlers.unknown_answer({ topic: "Parking", question: "is there parking?" });
  await handlers.unknown_answer({ topic: "parking", question: "where do I park?" });
  assertEquals(ctx.asked, ["admin-phone:parking"]);
});
