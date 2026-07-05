# TODOS

Deferred scope from reviews. Each entry has enough context to pick up cold.

## From /autoplan telegram-onboarding-revamp (2026-07-05)

### Proactive check-in frequency preference (P3, M→S with CC)
- **What:** Let the athlete choose how often the coach proactively pings (daily / around sessions / weekly / only when I write).
- **Why:** Completes the "everything is changeable" preference model; wrong default cadence is a churn risk.
- **Context:** Needs the proactive-messaging design first (what pings exist, quiet hours). Prefs would live in `athleticHistory.coach_prefs`; the choices layer from PR 1 renders the keyboards. Start: define ping taxonomy, then one more /settings question.
- **Blocked by:** proactive messaging design.

### Language / locale selection (P3, M→S with CC)
- **What:** Onboarding language question + localized coach replies (`athletes.locale` column exists, unused).
- **Why:** Berlin market — German-first athletes will churn on English-only coaching.
- **Context:** Prompts are English; needs prompt i18n strategy (per-locale prompt variants vs in-context instruction). Start: in-context "reply in {locale}" experiment + eval.

### Two-way calendar sync (P3, XL→L with CC)
- **What:** Athlete moves/deletes a session in Google Calendar → plan adapts.
- **Why:** Calendar becomes the editing surface, not just a mirror.
- **Context:** Requires Google OAuth (gated PR 4), watch channels/webhooks, conflict resolution policy, and the plan-adjust engine as the write path. Own project. Start only after OAuth ships and webcal proves insufficient.

### process-incoming.ts router refactor (P3, L→M with CC)
- **What:** Extract the ~1000-line inline branch chain into an intents registry.
- **Why:** Hottest file in the repo (20 touches/30 days); every feature lands here; merge-conflict and regression magnet.
- **Context:** PR 1 already extracts NEW intents as modules — this TODO migrates the existing branches (consent, pivot, reminders, erasure, strava, files) to the same registry. Pure refactor, needs the flow tests green as the safety net.

### WhatsApp interactive quick-replies (P3, M→S with CC)
- **What:** Twilio WhatsApp quick-reply buttons as the WhatsApp equivalent of Telegram inline keyboards.
- **Why:** If launch channel = WhatsApp, launch users currently get numbered-text fallback.
- **Context:** Twilio Content API templates; approval lead time applies. Decision depends on the launch-channel call (see plan's Open strategy flags).

### Telegram HTML parse-mode (P3, S with CC)
- **What:** Rich formatting (bold headers) in Telegram sends via parse_mode=HTML + escaper on all outbound text + 400→plain-text retry in sendOne.
- **Why:** Appendix A copy reads better with bold; currently plain text only.
- **Context:** Enabling Markdown naively makes every LLM-generated send a `400 can't parse entities` hazard (underscores/asterisks in coach replies). Needs escaping applied at the send boundary + fallback retry. From eng finding 12 of the onboarding revamp review.
