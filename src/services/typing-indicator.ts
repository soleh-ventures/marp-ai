// The native WhatsApp "typing…" affordance, fired the moment an LLM-bound
// branch starts. Replaces the old literal "thinking…" text message, which
// cluttered the chat with an extra bubble on every turn — the runner asked for
// a real "is typing" signal instead. Twilio's typing indicator (Public Beta,
// Oct 2025) shows the native state referencing the runner's inbound message and
// auto-clears when our reply lands or after 25s.
//
// Fire-and-forget: never await, never persist to the messages table. It's an
// operational nudge, not part of conversation memory. If the beta API fails the
// reply still sends — the runner just doesn't see the bubble.
//
// Suppressed on fast paths (consent, dormancy, deletion, Strava-connect,
// file-ingest) where the reply lands in <500ms and a bubble would flicker.

import { sendTypingIndicator } from "./twilio-send.js";

// Fire the typing indicator for the runner's inbound message. No-op when the
// inbound SID is missing (e.g. a synthetic / non-Twilio-driven turn).
export function fireTypingIndicator(inboundSid: string | null | undefined): void {
  if (!inboundSid) return;
  void sendTypingIndicator(inboundSid);
}
