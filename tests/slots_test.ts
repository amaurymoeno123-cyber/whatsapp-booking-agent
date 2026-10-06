import { assertEquals, assertThrows } from "@std/assert";
import { checkDate, checkRange, freeSlots, overlaps, toHHMM, toMinutes } from "../src/slots.ts";

Deno.test("converts between HH:MM and minutes", () => {
  assertEquals(toMinutes("09:30"), 570);
  assertEquals(toHHMM(570), "09:30");
  assertEquals(toHHMM(1440), "24:00");
  assertThrows(() => toMinutes("25:00"));
  assertThrows(() => toMinutes("9am"));
});

Deno.test("an empty day is fully free", () => {
  assertEquals(freeSlots([]), [{ start: "00:00", end: "24:00" }]);
});

Deno.test("free slots are the gaps between unsorted busy ranges", () => {
  const busy = [{ start: "14:00", end: "16:00" }, { start: "09:00", end: "12:00" }];
  assertEquals(freeSlots(busy), [
    { start: "00:00", end: "09:00" },
    { start: "12:00", end: "14:00" },
    { start: "16:00", end: "24:00" },
  ]);
});

Deno.test("overlapping busy ranges merge", () => {
  const busy = [{ start: "09:00", end: "12:00" }, { start: "10:00", end: "13:00" }];
  assertEquals(freeSlots(busy, 8 * 60), [
    { start: "08:00", end: "09:00" },
    { start: "13:00", end: "24:00" },
  ]);
});

Deno.test("a booking ending at 00:00 means end of day", () => {
  assertEquals(freeSlots([{ start: "20:00", end: "00:00" }]), [{ start: "00:00", end: "20:00" }]);
});

Deno.test("today's slots start from the current minute", () => {
  assertEquals(freeSlots([], 15 * 60), [{ start: "15:00", end: "24:00" }]);
});

Deno.test("back-to-back ranges do not overlap", () => {
  assertEquals(overlaps({ start: "09:00", end: "12:00" }, { start: "12:00", end: "13:00" }), false);
  assertEquals(overlaps({ start: "09:00", end: "12:00" }, { start: "11:59", end: "13:00" }), true);
});

Deno.test("validates requested dates", () => {
  const opts = { maxDaysAhead: 30, openDays: ["mon", "tue", "wed", "thu", "fri"] as const };
  const check = (d: string) =>
    checkDate(d, "2030-01-07", { ...opts, openDays: [...opts.openDays] });
  assertEquals(check("2030-01-07"), { ok: true, day: "mon" });
  assertEquals(check("2030-01-06"), { ok: false, reason: "past_date" });
  assertEquals(check("2030-01-12"), { ok: false, reason: "closed" });
  assertEquals(check("2030-03-01"), { ok: false, reason: "too_far" });
  assertEquals(check("next friday"), { ok: false, reason: "invalid_date" });
});

Deno.test("validates time ranges", () => {
  assertEquals(checkRange({ start: "09:00", end: "12:00" }).ok, true);
  assertEquals(checkRange({ start: "22:00", end: "00:00" }).ok, true);
  assertEquals(checkRange({ start: "12:00", end: "09:00" }).ok, false);
  assertEquals(checkRange({ start: "noon", end: "13:00" }).ok, false);
});
