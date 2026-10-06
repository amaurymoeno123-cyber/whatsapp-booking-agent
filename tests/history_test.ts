import { assertEquals } from "@std/assert";
import { type StoredMessage, toChatHistory } from "../src/history.ts";

const msg = (i: number, role: StoredMessage["role"] = "customer"): StoredMessage => ({
  role,
  body: `message ${i}`,
  created_at: `2030-01-01T00:${String(i).padStart(2, "0")}:00Z`,
});

Deno.test("keeps the LAST messages, oldest first, whatever the input order", () => {
  const rows = Array.from({ length: 40 }, (_, i) => msg(i)).reverse();
  const history = toChatHistory(rows, 30);
  assertEquals(history.length, 30);
  assertEquals(history[0].content, "message 10");
  assertEquals(history[29].content, "message 39");
});

Deno.test("staff replies count as assistant turns", () => {
  const history = toChatHistory([msg(1), msg(2, "bot"), msg(3, "human")]);
  assertEquals(history.map((m) => m.role), ["user", "assistant", "assistant"]);
});
