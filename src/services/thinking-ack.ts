// V1 (v1.1 flow redesign) — single "thinking…" ack, fired immediately
// when an LLM-bound branch starts. Replaces the v1 setTimeout(5s) +
// 8-phrase variation pattern. The user's feedback was explicit:
// runners want a plain "MARP is processing" signal the moment they hit
// send, not a clever runner-flavoured phrase that arrives after 5s.
//
// Fire-and-forget: never await; never persist to the messages table.
// It's an operational nudge, not part of conversation memory.
//
// Suppressed on fast paths (consent, dormancy, deletion, Strava-connect,
// file-ingest) where the reply lands in <500ms and an ack would just
// clutter the chat.

import { sendWhatsApp } from "./twilio-send.js";

export const THINKING_ACK = "thinking…";

export function fireThinkingAck(phone: string): void {
  sendWhatsApp(phone, THINKING_ACK).catch((err) =>
    console.error("thinking-ack send failed:", err),
  );
}
