/** What the webhook cares about, extracted from Meta's nested payload. */
export type InboundEvent =
  | {
    kind: "message";
    id: string;
    from: string;
    type: "text" | "audio" | "unsupported";
    text?: string;
    mediaId?: string;
  }
  | {
    kind: "status";
    messageId: string;
    recipient: string;
    status: string;
    errorCode?: number;
    errorTitle?: string;
  };

const MAX_TEXT = 1000;

// deno-lint-ignore no-explicit-any
type Json = any;

export function parseWebhook(body: Json): InboundEvent[] {
  const events: InboundEvent[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};

      // Delivery receipts. A 200 from the send API is not a delivery: Meta can drop the
      // message later, and the only trace is a failed status here.
      for (const st of value.statuses ?? []) {
        if (!st?.id) continue;
        const err = st.errors?.[0];
        events.push({
          kind: "status",
          messageId: String(st.id),
          recipient: String(st.recipient_id ?? ""),
          status: String(st.status ?? ""),
          errorCode: err?.code,
          errorTitle: err?.title,
        });
      }

      for (const m of value.messages ?? []) {
        // Users who hide their number arrive with `from_user_id` instead of `from`.
        // Requiring `from` silently drops them.
        const from = String(m?.from ?? m?.from_user_id ?? "");
        const id = String(m?.id ?? "");
        if (!from || !id) continue;

        if (m.type === "text") {
          events.push({ kind: "message", id, from, type: "text", text: clip(m.text?.body) });
        } else if (m.type === "interactive") {
          const title = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
          events.push({ kind: "message", id, from, type: "text", text: clip(title) });
        } else if (m.type === "audio" || m.type === "voice") {
          const mediaId = String(m.audio?.id ?? m.voice?.id ?? "");
          events.push({ kind: "message", id, from, type: "audio", mediaId });
        } else {
          // Reactions, stickers, system notices. Answering them made the bot talk about
          // "the audio that didn't arrive" for the rest of the conversation.
          events.push({ kind: "message", id, from, type: "unsupported" });
        }
      }
    }
  }
  return events;
}

function clip(value: unknown): string {
  return String(value ?? "").slice(0, MAX_TEXT);
}
