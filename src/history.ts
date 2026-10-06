import type { ChatMessage } from "./agent.ts";

export type StoredMessage = {
  role: "customer" | "bot" | "human";
  body: string;
  created_at: string;
};

/**
 * Turns stored rows into the model's chat history: the LAST `limit` messages, oldest first.
 *
 * Production bug this guards against: the query used `order asc limit 30`, which returns
 * the FIRST 30 messages. Past message 30 the model never saw what the customer wrote and
 * kept answering the same old message. Rows here may come in any order.
 */
export function toChatHistory(rows: StoredMessage[], limit = 30): ChatMessage[] {
  return [...rows]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-limit)
    .map((row) => ({
      // What a staff member types from the panel is part of the thread too.
      role: row.role === "customer" ? "user" as const : "assistant" as const,
      content: row.body,
    }));
}
