// T13 — "I'm working on it" acknowledgement when the LLM router takes
// longer than ACK_DELAY_MS. The webhook returns 200 to Twilio immediately
// and processes in the background; without this ack a multi-domain
// query can leave the runner staring at silence for 15-25 s.
//
// Copy rules:
//   - Short (a single WhatsApp line, no markdown).
//   - In MARP's voice — running-flavoured language where it lands
//     naturally, plain conversation otherwise. The runner shouldn't
//     ever think "this is a canned status message from a chatbot."
//   - Varied — pick at random each time so a runner who triggers
//     the ack twice in a row doesn't see the same phrase twice.
//   - No timing promises. We don't know how long it'll really take;
//     "hang tight" is honest, "give me 5 more seconds" isn't.

export const ACK_DELAY_MS = 5_000;

const THINKING_ACK_MESSAGES = [
  "Hold the pace — let me think this one through.",
  "Easy now, running through it.",
  "Give me a sec, lacing up the answer.",
  "Working through this — back in a moment.",
  "Let me dial this in properly.",
  "Hang tight, pulling it together.",
  "On it — chewing on this for a sec.",
  "Hold up, this one needs a real answer not a quick one.",
];

export function pickThinkingAck(rng: () => number = Math.random): string {
  const idx = Math.floor(rng() * THINKING_ACK_MESSAGES.length);
  // Safe non-null assertion: idx is bounded by the array length and
  // length > 0 is enforced by the unit test below.
  return THINKING_ACK_MESSAGES[idx]!;
}

// Exposed for tests that want to assert on the canned-set as a whole
// (e.g. "every line is short enough to fit").
export const _thinkingAckMessages = THINKING_ACK_MESSAGES;
