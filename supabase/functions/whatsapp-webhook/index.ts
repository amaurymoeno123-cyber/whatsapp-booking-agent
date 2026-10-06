import { createClient } from "@supabase/supabase-js";
import { runAgent } from "../../../src/agent.ts";
import { openAIModel, supabaseBookingRepo, whatsApp } from "../../../src/adapters.ts";
import { toChatHistory } from "../../../src/history.ts";
import { type InboundEvent, parseWebhook } from "../../../src/inbound.ts";
import {
  followUpMessage,
  looksLikeBookingRequest,
  parseAdminReply,
} from "../../../src/learning.ts";
import { buildSystemPrompt } from "../../../src/prompt.ts";
import { verifyMetaSignature } from "../../../src/signature.ts";
import { type DayKey, isoDate, localNow } from "../../../src/slots.ts";
import { createHandlers, TOOL_SPECS } from "../../../src/tools.ts";

const env = (name: string) => Deno.env.get(name) ?? "";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const wa = whatsApp(env("WA_PHONE_NUMBER_ID"), env("WA_TOKEN"));
const model = openAIModel(env("OPENAI_API_KEY"), env("OPENAI_MODEL") || "gpt-4o");
const repo = supabaseBookingRepo(db);

const UTC_OFFSET = Number(env("UTC_OFFSET_HOURS") || "-5");
const OPEN_DAYS = (env("OPEN_DAYS") || "mon,tue,wed,thu,fri,sat").split(",") as DayKey[];
const HUMAN_TAKEOVER_MS = 24 * 3_600_000;
const FALLBACK_REPLY = "Give me a second and try again: could you repeat your last message?";

Deno.serve(async (req) => {
  if (req.method === "GET") return verifySubscription(new URL(req.url));
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  const signed = await verifyMetaSignature(
    raw,
    req.headers.get("x-hub-signature-256"),
    env("META_APP_SECRET"),
  );
  if (!signed) return new Response("bad signature", { status: 401 });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // Awaited on purpose. Background work with waitUntil got cut mid-task by the edge
  // runtime and the bot went silent. Meta allows enough time for one LLM round trip.
  for (const event of parseWebhook(body)) {
    try {
      await handle(event);
    } catch (error) {
      console.error("event failed", event, error);
    }
  }
  return new Response("ok");
});

function verifySubscription(url: URL): Response {
  const ok = url.searchParams.get("hub.mode") === "subscribe" &&
    url.searchParams.get("hub.verify_token") === env("WA_VERIFY_TOKEN") &&
    env("WA_VERIFY_TOKEN") !== "";
  return ok
    ? new Response(url.searchParams.get("hub.challenge") ?? "")
    : new Response("forbidden", { status: 403 });
}

async function handle(event: InboundEvent): Promise<void> {
  if (event.kind === "status") {
    await db.from("delivery_status").upsert({
      message_id: event.messageId,
      recipient: event.recipient,
      status: event.status,
      error_code: event.errorCode ?? null,
      error_title: event.errorTitle ?? null,
      updated_at: new Date().toISOString(),
    });
    return;
  }
  if (event.type === "unsupported") return;

  const { data: contact, error } = await db.from("contacts")
    .upsert({ phone: event.from, last_message_at: new Date().toISOString() }, {
      onConflict: "phone",
    })
    .select("id, name, registered, control, control_changed_at").single();
  if (error) throw error;

  const text = event.type === "audio" ? await transcribe(event.mediaId ?? "") : event.text ?? "";
  if (!text.trim()) return;

  // Idempotency: Meta retries webhooks. The unique wa_message_id rejects the duplicate.
  const { error: dup } = await db.from("messages").insert({
    contact_id: contact.id,
    role: "customer",
    body: text,
    wa_message_id: event.id,
  });
  if (dup?.code === "23505") return;
  if (dup) throw dup;
  await wa.markRead(event.id);

  // Staff took over. If they forget to hand it back, the bot resumes after 24 h:
  // otherwise that conversation would stay silent forever without anyone noticing.
  if (contact.control === "human") {
    if (Date.now() - Date.parse(contact.control_changed_at) < HUMAN_TAKEOVER_MS) return;
    await db.from("contacts").update({
      control: "bot",
      control_changed_at: new Date().toISOString(),
    })
      .eq("id", contact.id);
  }

  if (await handleAdminAnswer(event.from, contact.id, text)) return;

  const reply = await think(contact, event.from);
  await db.from("messages").insert({ contact_id: contact.id, role: "bot", body: reply });
  await wa.sendText(event.from, reply);
}

/** An admin answering a question the bot couldn't. Learned without going through the model. */
async function handleAdminAnswer(phone: string, contactId: string, text: string): Promise<boolean> {
  if (looksLikeBookingRequest(text)) return false;
  const { data: admin } = await db.from("admins").select("phone").eq("phone", phone).eq(
    "active",
    true,
  )
    .maybeSingle();
  if (!admin) return false;

  const parsed = parseAdminReply(text);
  const { data: r } = await db.rpc("answer_gap", {
    p_admin_phone: phone,
    p_answer: parsed.action === "learn" ? parsed.answer : text,
    p_skip: parsed.action === "skip",
  });
  if (!r?.found) return false;

  let confirmation: string;
  if (r.action === "learned") {
    const notify: string[] = r.notify ?? [];
    for (const asker of notify) await wa.sendText(asker, followUpMessage(r.topic, r.answer));
    confirmation = `Learned. Next time someone asks about "${r.topic}" I'll answer that.` +
      (notify.length ? ` I already told the ${notify.length} people who asked.` : "");
  } else if (r.action === "skipped") {
    confirmation = `Ok, skipping "${r.topic}".`;
  } else {
    confirmation = `Could you write the full answer? It's what I'll tell people who ask about ` +
      `"${r.topic}". Reply "skip" if it doesn't apply.`;
  }
  await db.from("messages").insert({ contact_id: contactId, role: "bot", body: confirmation });
  await wa.sendText(phone, confirmation);
  return true;
}

async function think(
  contact: { id: string; name: string | null; registered: boolean },
  phone: string,
): Promise<string> {
  const now = new Date();
  const local = localNow(now, UTC_OFFSET);
  const todayIso = isoDate(local);

  const [history, knowledge, config, upcoming] = await Promise.all([
    db.from("messages").select("role, body, created_at").eq("contact_id", contact.id)
      .order("created_at", { ascending: false }).limit(30),
    db.from("knowledge").select("topic, answer").eq("active", true).limit(60),
    db.from("bot_config").select("value").eq("key", "system_prompt").maybeSingle(),
    contact.registered ? repo.upcomingFor(contact.id, todayIso) : Promise.resolve([]),
  ]);

  const system = buildSystemPrompt({
    base: config.data?.value ?? "You are a booking assistant.",
    knowledge: knowledge.data ?? [],
    now,
    utcOffsetHours: UTC_OFFSET,
    customerName: contact.registered ? contact.name : null,
    upcoming,
  });

  const handlers = createHandlers(repo, {
    contactId: contact.registered ? contact.id : null,
    phone,
    todayIso,
    nowMinute: local.getUTCHours() * 60 + local.getUTCMinutes(),
    openDays: OPEN_DAYS,
    maxDaysAhead: 30,
    askAdmin: async (admin, topic, question) => {
      await wa.sendText(
        admin,
        `Someone asked something I couldn't answer:\n\n"${question}"\n\n` +
          `What should I say when people ask about "${topic}"? Reply here and I'll learn it, ` +
          `or reply "skip".`,
      );
    },
  });

  const { reply } = await runAgent({
    model,
    tools: TOOL_SPECS,
    handlers,
    messages: [{ role: "system", content: system }, ...toChatHistory(history.data ?? [])],
  });
  if (reply) return reply;

  // Never fail silently: from the outside, silence looks exactly like being down.
  console.error("agent produced no reply", phone);
  return FALLBACK_REPLY;
}

async function transcribe(mediaId: string): Promise<string> {
  if (!mediaId) return "";
  const auth = { Authorization: `Bearer ${env("WA_TOKEN")}` };
  const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: auth });
  if (!meta.ok) return "";
  const { url, mime_type } = await meta.json();
  const audio = await fetch(url, { headers: auth });
  if (!audio.ok) return "";

  const form = new FormData();
  form.append("file", new Blob([await audio.arrayBuffer()], { type: mime_type }), "voice.ogg");
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
    body: form,
  });
  if (!res.ok) return "";
  return String((await res.json()).text ?? "");
}
