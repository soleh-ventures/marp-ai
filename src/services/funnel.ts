// Onboarding funnel observability (autoplan decision E10/#14).
//
// One structured log line per funnel step — greppable in Railway logs:
//   evt=onboarding_funnel step=prefs_answered athlete=<id>
// No new infra; the metric that says onboarding works is the conversion
// between these lines, and the one that says it's broken is a sustained
// evt=callback_error rate.

export type FunnelStep =
  | "onboarding_started"
  | "prefs_answered"
  | "holistic_answered"
  | "pivot_chosen"
  | "plan_created"
  | "calendar_connected";

export function logFunnel(step: FunnelStep, athleteId: string): void {
  try {
    console.log(`evt=onboarding_funnel step=${step} athlete=${athleteId}`);
  } catch {
    // Logging must never break the flow.
  }
}
