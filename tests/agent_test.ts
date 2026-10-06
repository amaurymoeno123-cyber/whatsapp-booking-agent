import { assertEquals } from "@std/assert";
import { type ChatMessage, type ChatModel, runAgent } from "../src/agent.ts";

/** A model that replays scripted answers and records what it was sent. */
function scripted(...answers: (ChatMessage | null)[]): ChatModel & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    complete(messages) {
      calls.push([...messages]);
      return Promise.resolve(answers.shift() ?? null);
    },
  };
}

const toolCall = (name: string, args: string, id = "call_1"): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
});
const say = (content: string): ChatMessage => ({ role: "assistant", content });
const start: ChatMessage[] = [{ role: "user", content: "anything free tomorrow?" }];

Deno.test("returns the text answer when no tool is needed", async () => {
  const result = await runAgent({
    model: scripted(say(" Hi! ")),
    tools: [],
    handlers: {},
    messages: start,
  });
  assertEquals(result, { reply: "Hi!", toolsUsed: [] });
});

Deno.test("runs a tool and feeds the result back to the model", async () => {
  const model = scripted(
    toolCall("check_availability", '{"date":"2030-01-10"}'),
    say("9 to 12 is free"),
  );
  const result = await runAgent({
    model,
    tools: [],
    handlers: { check_availability: (args) => Promise.resolve({ ok: true, date: args.date }) },
    messages: start,
  });
  assertEquals(result, { reply: "9 to 12 is free", toolsUsed: ["check_availability"] });
  assertEquals(model.calls[1].at(-1), {
    role: "tool",
    tool_call_id: "call_1",
    content: '{"ok":true,"date":"2030-01-10"}',
  });
});

Deno.test("broken arguments, unknown tools and throwing tools become error results", async () => {
  const model = scripted(
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "known", arguments: "{not json" } },
        { id: "b", type: "function", function: { name: "missing", arguments: "{}" } },
        { id: "c", type: "function", function: { name: "explodes", arguments: "{}" } },
      ],
    },
    say("sorry, let me check with the team"),
  );
  const result = await runAgent({
    model,
    tools: [],
    handlers: {
      known: () => Promise.resolve({ ok: true }),
      explodes: () => Promise.reject(new Error("db down")),
    },
    messages: start,
  });
  assertEquals(result.reply, "sorry, let me check with the team");
  const results = model.calls[1].slice(-3).map((m) =>
    m.role === "tool" ? JSON.parse(m.content) : null
  );
  assertEquals(results, [
    { ok: false, reason: "invalid_arguments" },
    { ok: false, reason: "unknown_tool" },
    { ok: false, reason: "tool_error" },
  ]);
});

Deno.test("gives up after maxRounds instead of looping forever", async () => {
  const loop = Array.from({ length: 10 }, (_, i) => toolCall("ping", "{}", `call_${i}`));
  const result = await runAgent({
    model: scripted(...loop),
    tools: [],
    handlers: { ping: () => Promise.resolve({ ok: true }) },
    messages: start,
    maxRounds: 3,
  });
  assertEquals(result, { reply: null, toolsUsed: ["ping", "ping", "ping"] });
});

Deno.test("returns null when the model fails or answers empty", async () => {
  const run = (answer: ChatMessage | null) =>
    runAgent({ model: scripted(answer), tools: [], handlers: {}, messages: start });
  assertEquals((await run(null)).reply, null);
  assertEquals((await run(say("  "))).reply, null);
});
