import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildSystemPrompt } from "../src/prompt.ts";

// 2030-01-08 03:00 UTC is still Monday the 7th in Colombia (UTC-5).
const now = new Date("2030-01-08T03:00:00Z");

Deno.test("uses the business's local date, not the server's", () => {
  const prompt = buildSystemPrompt({ base: "Base.", knowledge: [], now, utcOffsetHours: -5 });
  assertStringIncludes(prompt, "today is Monday 2030-01-07, 22:00 local time");
  assertStringIncludes(prompt, "tomorrow = 2030-01-08");
  assertStringIncludes(prompt, "Monday = 2030-01-14");
});

Deno.test("injects what the team taught and the customer's bookings", () => {
  const prompt = buildSystemPrompt({
    base: "Base.",
    knowledge: [{ topic: "parking", answer: "free in the basement" }],
    now,
    utcOffsetHours: -5,
    customerName: "Ana",
    upcoming: [{ date: "2030-01-09", start: "09:00", end: "12:00", status: "pending" }],
  });
  assertStringIncludes(prompt, "- parking: free in the basement");
  assertStringIncludes(prompt, "Their upcoming bookings: 2030-01-09 09:00-12:00 (pending)");
  assertEquals(prompt.startsWith("Base."), true);
});

Deno.test("says so when the customer is not registered", () => {
  const prompt = buildSystemPrompt({ base: "Base.", knowledge: [], now, utcOffsetHours: -5 });
  assertStringIncludes(prompt, "not registered yet");
});
