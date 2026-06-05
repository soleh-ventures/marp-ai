// V8 (v1.1 flow redesign) — reminder message templates.
//
// One template per session type. Templated (not LLM-generated) so:
//   - Cost stays at zero per reminder
//   - Reminders are uniform / predictable for the runner
//   - V9 calendar link can be appended cleanly
//
// Voice: brief, runner-flavoured, no theatre. The reminder lands
// before the run; the runner needs the WHAT in two seconds.

import type { PlanSession } from "../plan/types.js";

export type BuildReminderInput = {
  name: string;
  session: PlanSession;
  // V9: optional calendar links — included when caller built them. The
  // scheduler builds these per-athlete using their reminder time_local
  // and a freshly-signed cal token.
  icsUrl?: string;
  googleUrl?: string;
  // F7: true for a night-before reminder (describes tomorrow's session,
  // sent the evening before). Changes the greeting + day framing.
  nightBefore?: boolean;
};

export function buildReminderText(input: BuildReminderInput): string {
  const headline = describeSession(input.session);
  const why = input.session.reasoning ? `\n\nWhy: ${input.session.reasoning}` : "";
  const named = input.name && input.name !== "you";
  let body: string;
  if (input.nightBefore) {
    const lead = named ? `Evening ${input.name} — ` : "Evening — ";
    body = `${lead}tomorrow's session:\n\n${headline}${why}`;
  } else {
    const lead = named ? `Morning ${input.name} — ` : "Morning — ";
    body = `${lead}today's session:\n\n${headline}${why}`;
  }
  if (input.icsUrl || input.googleUrl) {
    body += "\n\nAdd to calendar:";
    if (input.icsUrl) body += `\n${input.icsUrl}`;
    if (input.googleUrl) body += `\n${input.googleUrl}`;
  }
  return body;
}

function describeSession(s: PlanSession): string {
  const dist = s.distance_km ? `${s.distance_km}km` : null;
  const dur = s.duration_min ? `${s.duration_min}min` : null;
  const size = [dist, dur].filter(Boolean).join(" / ");
  switch (s.type) {
    case "easy":
      return size ? `Easy ${size}. ${s.description}` : `Easy run. ${s.description}`;
    case "long":
      return size ? `Long ${size}. ${s.description}` : `Long run. ${s.description}`;
    case "tempo":
      return size ? `Tempo ${size}. ${s.description}` : `Tempo. ${s.description}`;
    case "intervals":
      return size
        ? `Intervals (${size} total). ${s.description}`
        : `Intervals. ${s.description}`;
    case "race":
      return `Race day. ${s.description}`;
    case "strides":
      return `Strides. ${s.description}`;
    case "cross":
      return size ? `Cross-training ${size}. ${s.description}` : `Cross-training. ${s.description}`;
    case "rest":
      // Should be filtered before reaching here, but be safe.
      return "Rest day.";
  }
}
