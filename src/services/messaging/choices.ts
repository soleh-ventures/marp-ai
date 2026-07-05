// Choices layer — the shared primitive behind every closed question MARP asks
// (preference taps, consent, pivot, calendar offer, reminder times).
//
// One principle: a tap and a typed answer are the SAME thing. Buttons carry
// versioned callback data that decodes to a canonical text value; free text is
// matched leniently against the same values. Both funnel into one pipeline.
//
// Callback data format (Telegram caps callback_data at 64 bytes):
//   v1:<questionId>:<value>
// Unknown versions decode to null — old buttons in chat history survive
// deploys by getting a "menu expired" toast instead of a crash.

export type Choice = {
  // Canonical value — what the tap "types" into the pipeline (e.g. "director").
  value: string;
  // Button label, ≤24 chars, max one emoji (design rule from the plan).
  label: string;
  // Extra words the lenient matcher accepts (e.g. "hard" for "director").
  synonyms?: string[];
};

export type ChoiceQuestion = {
  // Short stable id, used in callback data + pending-question state.
  id: string;
  choices: Choice[];
};

const CALLBACK_VERSION = "v1";

export function encodeCallback(questionId: string, value: string): string {
  const data = `${CALLBACK_VERSION}:${questionId}:${value}`;
  if (Buffer.byteLength(data, "utf8") > 64) {
    throw new Error(`callback data exceeds Telegram's 64-byte cap: ${data}`);
  }
  return data;
}

export type DecodedCallback = { questionId: string; value: string };

// Null means "not ours / wrong version" — the caller answers with an
// expired-menu toast rather than guessing.
export function decodeCallback(data: string): DecodedCallback | null {
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [version, questionId, value] = parts;
  if (version !== CALLBACK_VERSION || !questionId || !value) return null;
  return { questionId, value };
}

// Telegram inline keyboard: one full-width button per row — our labels carry
// meaning ("⚖️ Partner — decide together" style lives in the message text;
// the button itself stays short) and single-column reads best on mobile.
export function buildInlineKeyboard(question: ChoiceQuestion): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: question.choices.map((c) => [
      { text: c.label, callback_data: encodeCallback(question.id, c.value) },
    ]),
  };
}

// Text fallback for WhatsApp / CHOICES_UI=text: numbered options appended to
// the message body. The lenient matcher accepts the number, the value, or the
// label so "1", "director" and "🎯 Director" all land.
export function renderTextFallback(question: ChoiceQuestion): string {
  const lines = question.choices.map((c, i) => `${i + 1}. ${c.label}`);
  const nums = question.choices.map((_, i) => `${i + 1}`);
  const numList =
    nums.length > 1
      ? `${nums.slice(0, -1).join(", ")} or ${nums[nums.length - 1]}`
      : nums[0];
  return `\n\n${lines.join("\n")}\nReply ${numList}.`;
}

// Strip emoji/punctuation and lowercase for fuzzy comparisons.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Guardrail from the eng review: lenient matching ONLY for short messages.
// "yesterday's run was really hard" must never match the "hard" option —
// anything longer than this goes down the answer-then-re-ask path instead.
const MAX_MATCH_LENGTH = 25;

// Match free text against a pending question. Accepts: the option number
// ("1", "2."), the canonical value ("director"), the label ("🎯 Director"),
// or a listed synonym ("hard"). Returns the canonical value or null.
export function matchFreeText(
  question: ChoiceQuestion,
  text: string,
): string | null {
  const raw = text.trim();
  if (raw.length === 0 || raw.length > MAX_MATCH_LENGTH) return null;
  const norm = normalize(raw);
  if (!norm) return null;

  // Bare option number ("1", "2.", "option 2").
  const numMatch = norm.match(/^(?:option\s+)?([0-9]+)$/);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    const choice = question.choices[idx];
    return choice ? choice.value : null;
  }

  for (const c of question.choices) {
    if (norm === normalize(c.value)) return c.value;
    if (norm === normalize(c.label)) return c.value;
    for (const syn of c.synonyms ?? []) {
      if (norm === normalize(syn)) return c.value;
    }
  }
  // Single-word containment: "the hard one" → strip filler words and see if
  // exactly one option word remains. Conservative: every non-filler token must
  // belong to the SAME option or we return null.
  const FILLER = new Set([
    "the", "one", "please", "pls", "i", "want", "go", "with", "lets", "do",
    "option", "pick", "choose", "take", "that", "id", "like", "me", "my",
  ]);
  const tokens = norm.split(" ").filter((t) => t && !FILLER.has(t));
  if (tokens.length === 0) return null;
  let matched: string | null = null;
  for (const t of tokens) {
    const owner = question.choices.find(
      (c) =>
        normalize(c.value) === t ||
        normalize(c.label).split(" ").includes(t) ||
        (c.synonyms ?? []).some((s) => normalize(s) === t),
    );
    if (!owner) return null; // token belongs to nobody → not a clean answer
    if (matched && matched !== owner.value) return null; // ambiguous
    matched = owner.value;
  }
  return matched;
}
