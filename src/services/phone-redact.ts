// Phone numbers are PII under GDPR. Treat them like passwords: route
// them through the codebase, never log them.
//
// Two rules:
//   1. Prefer logging the athlete UUID instead — every entity in the DB
//      is keyed by UUID, so it's the right debug handle anyway.
//   2. When a UUID isn't available (e.g. before findOrCreateByPhone
//      resolves), use redactPhone() so logs don't carry the full number.
//
// redactPhone keeps the country code + last 4 digits, which is enough
// to disambiguate during incident investigation without retaining a
// reversible identifier.

const DIGITS_RETAINED = 4;

export function redactPhone(phone: string | null | undefined): string {
  if (!phone) return "<no-phone>";
  // Strip the WhatsApp prefix Twilio adds. The natural-key form stored
  // in the DB is just the E.164 number; the prefix only appears on
  // inbound webhooks.
  const bare = phone.replace(/^whatsapp:/, "");
  // Keep leading "+" if present, then country-code-friendly stub +
  // last N digits.
  const sign = bare.startsWith("+") ? "+" : "";
  const digits = bare.replace(/[^0-9]/g, "");
  if (digits.length <= DIGITS_RETAINED) {
    // Tiny string — just stub it entirely; nothing meaningful to retain.
    return `${sign}***`;
  }
  return `${sign}***${digits.slice(-DIGITS_RETAINED)}`;
}
