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

// Phone dial code → ISO 3166-1 alpha-2 country. Kept alongside the
// timezone table (same prefix-matching logic) so one phone lookup gives
// us both the runner's timezone AND their country — the latter is a
// cheap, useful insight dimension (where are my users?) that we persist
// on the athlete row.
const PHONE_CODE_TO_COUNTRY: Record<string, string> = {
  "1": "US",
  "44": "GB",
  "33": "FR",
  "49": "DE",
  "39": "IT",
  "34": "ES",
  "31": "NL",
  "351": "PT",
  "353": "IE",
  "46": "SE",
  "47": "NO",
  "45": "DK",
  "358": "FI",
  "41": "CH",
  "43": "AT",
  "32": "BE",
  "48": "PL",
  "30": "GR",
  "62": "ID",
  "65": "SG",
  "60": "MY",
  "66": "TH",
  "84": "VN",
  "63": "PH",
  "81": "JP",
  "82": "KR",
  "86": "CN",
  "852": "HK",
  "886": "TW",
  "91": "IN",
  "92": "PK",
  "971": "AE",
  "972": "IL",
  "61": "AU",
  "64": "NZ",
  "55": "BR",
  "54": "AR",
  "52": "MX",
  "56": "CL",
  "57": "CO",
  "51": "PE",
  "27": "ZA",
  "20": "EG",
  "234": "NG",
  "254": "KE",
};

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
  return lookupByPhone(phone, PHONE_CODE_TO_TZ);
}

// Returns the ISO 3166-1 alpha-2 country code from an E.164 phone, or
// null when the prefix is unknown. Same longest-prefix matching as the
// timezone lookup. Persisted on the athlete row for insights.
export function inferCountryFromPhone(phone: string): string | null {
  return lookupByPhone(phone, PHONE_CODE_TO_COUNTRY);
}

function lookupByPhone(
  phone: string,
  table: Record<string, string>,
): string | null {
  const stripped = phone.replace(/^whatsapp:/, "").replace(/^\+/, "");
  if (!/^\d+$/.test(stripped)) return null;
  // Phone country codes vary in length (1-3 digits). Try longest
  // match first (3 → 2 → 1) so "44" doesn't shadow "441" etc.
  for (const len of [3, 2, 1]) {
    const prefix = stripped.slice(0, len);
    if (table[prefix]) return table[prefix];
  }
  return null;
}

// F8 (v1.2): resolve the timezone to use for an athlete. Prefers the
// explicitly-stored timezone, falls back to phone-code inference, then
// UTC. Used by every date-reasoning site so "today" and the weekday are
// computed in the runner's local frame, never UTC.
export function resolveTimezone(
  storedTz: string | null | undefined,
  phone: string,
): string {
  if (storedTz) return storedTz;
  return inferTimezoneFromPhone(phone) ?? "UTC";
}

export type ZonedNow = {
  // YYYY-MM-DD in the resolved timezone.
  date: string;
  // Lowercase weekday name, e.g. "friday".
  weekday: string;
  // The IANA timezone actually used (after resolution).
  timezone: string;
};

// F8 (v1.2): the single source of truth for "what day is it for this
// runner". Computes date + weekday in the resolved timezone via
// Intl.DateTimeFormat (DST-correct, no external dep). Every LLM payload
// that reasons about dates injects BOTH fields so the model never has to
// derive the weekday from a date string (LLMs get that wrong) and never
// sees a UTC-skewed date.
export function nowInZone(
  storedTz: string | null | undefined,
  phone: string,
  now: Date = new Date(),
): ZonedNow {
  const timezone = resolveTimezone(storedTz, phone);
  let date: string;
  let weekday: string;
  try {
    date = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
    })
      .format(now)
      .toLowerCase();
  } catch {
    // Bad timezone string — fall back to UTC rather than throw.
    date = now.toISOString().slice(0, 10);
    weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "long",
    })
      .format(now)
      .toLowerCase();
  }
  return { date, weekday, timezone };
}

// F8 (v1.2): the Monday on-or-after a given instant, in the resolved
// timezone, as YYYY-MM-DD. The plan generator uses this to set week-1's
// start_date in code rather than trusting the LLM's date arithmetic.
export function nextMonday(
  storedTz: string | null | undefined,
  phone: string,
  now: Date = new Date(),
): string {
  const { date, weekday } = nowInZone(storedTz, phone, now);
  const order = [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  ];
  const idx = order.indexOf(weekday);
  // Days until next Monday: 0 if already Monday, else 7 - idx.
  const addDays = idx <= 0 ? 0 : 7 - idx;
  // Parse the local date as a UTC midnight and add whole days — safe
  // because we only read the Y-M-D back out, never a wall-clock time.
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + addDays);
  return base.toISOString().slice(0, 10);
}
