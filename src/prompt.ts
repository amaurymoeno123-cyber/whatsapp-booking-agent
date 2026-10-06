import { isoDate, localNow } from "./slots.ts";

export type Knowledge = { topic: string; answer: string };
export type UpcomingBooking = { date: string; start: string; end: string; status: string };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Builds the system prompt from the editable base script plus computed state.
 *
 * Lesson from production: the model does not reliably deduce state from the chat
 * history. "What do I have booked?" or "is Friday the 10th?" must be answered from
 * facts computed here, not from the model's memory of the conversation.
 */
export function buildSystemPrompt(opts: {
  base: string;
  knowledge: Knowledge[];
  now: Date;
  utcOffsetHours: number;
  customerName?: string | null;
  upcoming?: UpcomingBooking[];
}): string {
  const today = localNow(opts.now, opts.utcOffsetHours);
  const parts = [opts.base.trim()];

  if (opts.knowledge.length) {
    parts.push(
      "WHAT THE TEAM HAS TAUGHT YOU (true, overrides any assumption):\n" +
        opts.knowledge.map((k) => `- ${k.topic}: ${k.answer}`).join("\n"),
    );
  }

  const dateMap = Array.from({ length: 8 }, (_, i) => {
    const d = new Date(today.getTime() + i * 86_400_000);
    const label = i === 0 ? "TODAY" : i === 1 ? "tomorrow" : WEEKDAYS[d.getUTCDay()];
    return `${label} = ${isoDate(d)}`;
  });
  const hhmm = today.toISOString().slice(11, 16);
  parts.push(
    `CONTEXT: today is ${WEEKDAYS[today.getUTCDay()]} ${isoDate(today)}, ${hhmm} local time.\n` +
      `Date map:\n${dateMap.join("\n")}`,
  );

  if (opts.customerName) {
    const list = (opts.upcoming ?? [])
      .map((b) => `${b.date} ${b.start}-${b.end} (${b.status})`)
      .join("; ");
    parts.push(
      `You are talking to ${opts.customerName}. Their upcoming bookings: ${list || "none"}. ` +
        "Answer 'what do I have booked?' from this list without calling a tool.",
    );
  } else {
    parts.push("This customer is not registered yet.");
  }

  return parts.join("\n\n");
}
