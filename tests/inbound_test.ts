import { assertEquals } from "@std/assert";
import { parseWebhook } from "../src/inbound.ts";

const wrap = (value: unknown) => ({ entry: [{ changes: [{ value }] }] });

Deno.test("extracts text, button replies and voice notes", () => {
  const events = parseWebhook(wrap({
    messages: [
      { from: "57300", id: "m1", type: "text", text: { body: "hola" } },
      {
        from: "57300",
        id: "m2",
        type: "interactive",
        interactive: { button_reply: { title: "Sí" } },
      },
      { from: "57300", id: "m3", type: "audio", audio: { id: "media-1" } },
    ],
  }));
  assertEquals(events, [
    { kind: "message", id: "m1", from: "57300", type: "text", text: "hola" },
    { kind: "message", id: "m2", from: "57300", type: "text", text: "Sí" },
    { kind: "message", id: "m3", from: "57300", type: "audio", mediaId: "media-1" },
  ]);
});

Deno.test("keeps users who hide their phone number", () => {
  const [event] = parseWebhook(wrap({
    messages: [{ from_user_id: "BSUID.123", id: "m1", type: "text", text: { body: "hi" } }],
  }));
  assertEquals(event.kind === "message" && event.from, "BSUID.123");
});

Deno.test("marks reactions and stickers as unsupported instead of answering them", () => {
  const [event] = parseWebhook(wrap({
    messages: [{ from: "57300", id: "m1", type: "reaction", reaction: { emoji: "👍" } }],
  }));
  assertEquals(event, { kind: "message", id: "m1", from: "57300", type: "unsupported" });
});

Deno.test("extracts failed delivery receipts", () => {
  const [event] = parseWebhook(wrap({
    statuses: [{
      id: "wamid.1",
      recipient_id: "57300",
      status: "failed",
      errors: [{ code: 131042, title: "Business eligibility payment issue" }],
    }],
  }));
  assertEquals(event, {
    kind: "status",
    messageId: "wamid.1",
    recipient: "57300",
    status: "failed",
    errorCode: 131042,
    errorTitle: "Business eligibility payment issue",
  });
});

Deno.test("clips very long messages and ignores malformed payloads", () => {
  const [event] = parseWebhook(wrap({
    messages: [{ from: "57300", id: "m1", type: "text", text: { body: "a".repeat(5000) } }],
  }));
  assertEquals(event.kind === "message" && event.text?.length, 1000);
  assertEquals(parseWebhook(null), []);
  assertEquals(parseWebhook({ entry: [{ changes: [{}] }] }), []);
});
