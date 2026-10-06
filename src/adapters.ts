import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatMessage, ChatModel, ToolSpec } from "./agent.ts";
import type { Booking, BookingRepo } from "./tools.ts";

/** OpenAI Chat Completions as a ChatModel. */
export function openAIModel(apiKey: string, model: string): ChatModel {
  return {
    async complete(messages: ChatMessage[], tools: ToolSpec[]) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, tools, max_completion_tokens: 400 }),
      });
      if (!res.ok) {
        // A 429 here means the shared account ran out of credit: every bot fails at once.
        console.error("openai error", res.status, await res.text());
        return null;
      }
      const data = await res.json();
      return data.choices?.[0]?.message ?? null;
    },
  };
}

/** Minimal WhatsApp Cloud API client. */
export function whatsApp(phoneNumberId: string, token: string) {
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  const post = (body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  return {
    /** `true` means Meta accepted it, not that it was delivered (see delivery_status). */
    async sendText(to: string, text: string): Promise<boolean> {
      const res = await post({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      });
      if (!res.ok) console.error("whatsapp send failed", res.status, await res.text());
      return res.ok;
    },
    async markRead(messageId: string): Promise<void> {
      await post({ messaging_product: "whatsapp", status: "read", message_id: messageId });
    },
  };
}

export function supabaseBookingRepo(db: SupabaseClient): BookingRepo {
  const hhmm = (t: string) => String(t).slice(0, 5);
  return {
    async busyRanges(date) {
      const { data, error } = await db.from("bookings")
        .select("contact_id, start_time, end_time")
        .eq("date", date).neq("status", "cancelled").order("start_time");
      if (error) throw error;
      return (data ?? []).map((r) => ({
        contactId: r.contact_id,
        start: hhmm(r.start_time),
        end: hhmm(r.end_time),
      }));
    },
    async upcomingFor(contactId, fromDate) {
      const { data, error } = await db.from("bookings")
        .select("date, start_time, end_time, status")
        .eq("contact_id", contactId).neq("status", "cancelled").gte("date", fromDate)
        .order("date").order("start_time").limit(8);
      if (error) throw error;
      return (data ?? []).map((r) => ({
        date: r.date,
        start: hhmm(r.start_time),
        end: hhmm(r.end_time),
        status: r.status as Booking["status"],
      }));
    },
    async requestBooking(contactId, date, range) {
      const { data, error } = await db.rpc("request_booking", {
        p_contact: contactId,
        p_date: date,
        p_start: range.start,
        p_end: range.end,
      });
      if (error) throw error;
      return data;
    },
    async cancelBooking(contactId, date, start) {
      const { data, error } = await db.from("bookings").update({ status: "cancelled" })
        .eq("contact_id", contactId).eq("date", date).eq("start_time", start)
        .neq("status", "cancelled").select("id");
      if (error) throw error;
      return (data ?? []).length > 0;
    },
    async registerGap(topic, question, phone) {
      const { data, error } = await db.rpc("register_gap", {
        p_topic: topic,
        p_question: question,
        p_phone: phone,
      });
      if (error) throw error;
      return { askAdmin: data?.ask_admin ?? null };
    },
  };
}
