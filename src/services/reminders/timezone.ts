// V8 (v1.1 flow redesign) — phone-code → IANA timezone inference.
//
// L3 decision: timezone gets captured after plan generation rather
// than in onboarding (to avoid mid-flow regressions). We seed a
// default from the runner's WhatsApp number's country code so MARP
// has SOMETHING reasonable for the first reminder, with explicit
// override available via chat ("I'm in Tokyo actually").
//
// Coverage: major MARP launch markets (EU, US, ID, SG, JP, AU, BR,
// IN). Unknown country codes fall back to UTC + a console warning;
// the cron's "skip if no timezone" guard means an unknown code just
// blocks reminders until the runner sets one explicitly. Better than
// firing reminders at 6am UTC for someone in Sydney.
//
// Phone numbers arrive E.164-prefixed by Twilio: "whatsapp:+E164"
// or "+E164". Strip the "whatsapp:" prefix before passing.

const PHONE_CODE_TO_TZ: Record<string, string> = {
  // North America — coarse: pick the most-populated TZ. Runners in
  // other US TZs override via chat.
  "1": "America/New_York",
  // Europe
  "44": "Europe/London",
  "33": "Europe/Paris",
  "49": "Europe/Berlin",
  "39": "Europe/Rome",
  "34": "Europe/Madrid",
  "31": "Europe/Amsterdam",
  "351": "Europe/Lisbon",
  "353": "Europe/Dublin",
  "46": "Europe/Stockholm",
  "47": "Europe/Oslo",
  "45": "Europe/Copenhagen",
  "358": "Europe/Helsinki",
  "41": "Europe/Zurich",
  "43": "Europe/Vienna",
  "32": "Europe/Brussels",
  "48": "Europe/Warsaw",
  "30": "Europe/Athens",
  // Asia
  "62": "Asia/Jakarta",
  "65": "Asia/Singapore",
  "60": "Asia/Kuala_Lumpur",
  "66": "Asia/Bangkok",
  "84": "Asia/Ho_Chi_Minh",
  "63": "Asia/Manila",
  "81": "Asia/Tokyo",
  "82": "Asia/Seoul",
  "86": "Asia/Shanghai",
  "852": "Asia/Hong_Kong",
  "886": "Asia/Taipei",
  "91": "Asia/Kolkata",
  "92": "Asia/Karachi",
  "971": "Asia/Dubai",
  "972": "Asia/Jerusalem",
  // Oceania
  "61": "Australia/Sydney",
  "64": "Pacific/Auckland",
  // Latin America
  "55": "America/Sao_Paulo",
  "54": "America/Argentina/Buenos_Aires",
  "52": "America/Mexico_City",
  "56": "America/Santiago",
  "57": "America/Bogota",
  "51": "America/Lima",
  // Africa
  "27": "Africa/Johannesburg",
  "20": "Africa/Cairo",
  "234": "Africa/Lagos",
  "254": "Africa/Nairobi",
};

// Returns an IANA timezone string from an E.164 phone (with or
// without leading "+", with or without "whatsapp:" prefix). Falls
// back to null when the prefix doesn't match a known code — caller
// should treat null as "no timezone, no reminders."
export function inferTimezoneFromPhone(phone: string): string | null {
  const stripped = phone.replace(/^whatsapp:/, "").replace(/^\+/, "");
  if (!/^\d+$/.test(stripped)) return null;

  // Phone country codes vary in length (1-3 digits). Try longest
  // match first (3 → 2 → 1) so "44" doesn't shadow "441" etc.
  for (const len of [3, 2, 1]) {
    const prefix = stripped.slice(0, len);
    if (PHONE_CODE_TO_TZ[prefix]) {
      return PHONE_CODE_TO_TZ[prefix];
    }
  }
  return null;
}
