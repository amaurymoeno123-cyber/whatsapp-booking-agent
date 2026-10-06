import { assertEquals } from "@std/assert";
import { looksLikeBookingRequest, parseAdminReply } from "../src/learning.ts";

Deno.test("admin replies: skip, too short, or learn", () => {
  assertEquals(parseAdminReply(" Saltar "), { action: "skip" });
  assertEquals(parseAdminReply("skip"), { action: "skip" });
  assertEquals(parseAdminReply("yes"), { action: "too_short" });
  assertEquals(parseAdminReply("Yes, free parking downstairs."), {
    action: "learn",
    answer: "Yes, free parking downstairs.",
  });
});

Deno.test("booking-sounding messages from admins are not taken as answers", () => {
  assertEquals(looksLikeBookingRequest("quiero reservar mañana a las 3"), true);
  assertEquals(looksLikeBookingRequest("is Friday available?"), true);
  assertEquals(looksLikeBookingRequest("can I book Friday at 3?"), true);
  assertEquals(looksLikeBookingRequest("Parking is free in the basement"), false);
});

Deno.test("answers that mention 'free' are still learned (regression)", () => {
  assertEquals(looksLikeBookingRequest("Sí, el parqueadero es libre y gratis"), false);
});
