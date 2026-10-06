export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** Anything that can complete a chat with tools. OpenAI in production, a fake in tests. */
export interface ChatModel {
  complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage | null>;
}

export type ToolResult = Record<string, unknown>;
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export type AgentResult = { reply: string | null; toolsUsed: string[] };

/**
 * The tool-calling loop: ask the model, run the tools it requests, feed results back,
 * until it answers in text or the round limit is hit.
 *
 * Returns `reply: null` when the model fails or loops; the caller decides the fallback
 * (and alerts a human), because silence looks exactly like the bot being down.
 */
export async function runAgent(opts: {
  model: ChatModel;
  tools: ToolSpec[];
  handlers: Record<string, ToolHandler>;
  messages: ChatMessage[];
  maxRounds?: number;
}): Promise<AgentResult> {
  const messages = [...opts.messages];
  const toolsUsed: string[] = [];
  const maxRounds = opts.maxRounds ?? 5;

  for (let round = 0; round < maxRounds; round++) {
    const msg = await opts.model.complete(messages, opts.tools);
    if (!msg || msg.role !== "assistant") return { reply: null, toolsUsed };

    if (msg.tool_calls?.length) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        toolsUsed.push(call.function.name);
        const result = await runTool(opts.handlers, call);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }

    const reply = (msg.content ?? "").trim();
    return { reply: reply || null, toolsUsed };
  }
  return { reply: null, toolsUsed };
}

async function runTool(handlers: Record<string, ToolHandler>, call: ToolCall): Promise<ToolResult> {
  const handler = handlers[call.function.name];
  if (!handler) return { ok: false, reason: "unknown_tool" };
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return { ok: false, reason: "invalid_arguments" };
  }
  try {
    return await handler(args);
  } catch (error) {
    console.error("tool failed", call.function.name, error);
    return { ok: false, reason: "tool_error" };
  }
}
