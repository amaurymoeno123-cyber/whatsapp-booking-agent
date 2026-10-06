/**
 * The bot that learns from its staff.
 *
 * 1. The model calls `unknown_answer` when it can't answer a business question.
 * 2. The database decides whether to ask an admin (one question per topic, 3 per day).
 * 3. The admin replies on WhatsApp; the answer becomes knowledge injected into every
 *    future conversation, and everyone who asked gets the answer automatically.
 *
 * This file holds the decisions that don't need a database, so they can be tested.
 */

export const MIN_ANSWER_LENGTH = 12;

export type AdminReply =
  | { action: "skip" }
  | { action: "too_short" }
  | { action: "learn"; answer: string };

export function parseAdminReply(text: string): AdminReply {
  const clean = text.trim();
  if (/^(skip|saltar)$/i.test(clean)) return { action: "skip" };
  if (clean.length < MIN_ANSWER_LENGTH) return { action: "too_short" };
  return { action: "learn", answer: clean };
}

/**
 * Admins also book through the same number. A message that sounds like a booking is
 * never treated as an answer to a pending question.
 */
export function looksLikeBookingRequest(text: string): boolean {
  return /reserv|agend|\bbook|cancel|horario|schedul|disponib|availab/i.test(text);
}

export function followUpMessage(topic: string, answer: string): string {
  return `Hi! I can now answer what you asked about ${topic}: ${answer}`;
}
