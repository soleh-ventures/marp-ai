<!-- /autoplan restore point: /Users/kemalghifari/.gstack/projects/soleh-ventures-marp-ai/soleh-ventures-telegram-onboarding-revamp-autoplan-restore-20260705-015240.md -->
# Telegram Onboarding Revamp — Coach Personalization, Holistic Intake, Calendar Integration

Branch: `soleh-ventures/telegram-onboarding-revamp` · Target: `master` · Status: DRAFT (pre-review)

## Problem

MARP's onboarding collects fitness facts (goal, mileage, injuries) but zero coaching
preferences. Every athlete gets the same hardcoded coach voice, the same reply length,
and the same plan aggressiveness. The intake is running-only — it never asks about other
sports, life load, or what the athlete wants coached. The post-onboarding integration
offer is Strava, which broke in June 2026 when Strava paywalled its API ($12/mo per
developer). And the calendar story is weak: per-session ICS/Google links buried inside
daily reminders, no way to put the whole plan in a calendar, no descriptions worth reading.

On Telegram we send plain text only — no inline keyboards — so every choice today is
"reply (a) or (b)" typed by hand. Telegram gives us tap-to-answer for free and we don't
use it.

## Goal

Best-in-class chat onboarding: fewer typed answers, more taps; a coach that sounds the
way the athlete wants, at the length they want; a plan calibrated to the intensity they
choose; a holistic picture of the athlete (other sports, life context, coaching topics);
and a Google Calendar integration that puts the full plan — with detailed session
descriptions — into the athlete's calendar and keeps it there when the plan adapts.
Strava disappears from the offering; Garmin (founder-only) and Google Calendar become
the offered integrations.

## What exists today (verified in code)

- **Onboarding**: `src/flows/onboarding.ts` state machine + `prompts/onboarding.md`.
  One compact numbered-list message, LLM extraction, 3-turn pattern, 12-turn ceiling.
  Fields land as top-level keys in `athletes.athleticHistory` JSONB.
- **No preference capture anywhere**: no coaching style, reply length, or training
  style fields. `preferred_time` is captured but never read. Coach voice is hardcoded
  in `prompts/synthesizer.md` and `prompts/domains/*`.
- **Telegram adapter**: `src/webhooks/telegram.ts` (text-only, silently acks
  callback_query), `src/services/messaging/telegram-send.ts` (plain `sendMessage`,
  no `reply_markup`). Channel routing in `src/services/messaging/deliver.ts`;
  `MESSAGING_CHANNEL=telegram` mode active in prod.
- **Pivot**: `src/services/post-onboarding-pivot.ts` — typed "(a) or (b)" choice.
- **Calendar**: per-session ICS (`src/services/cal/build.ts`, `src/routes/cal.ts`,
  HMAC token in `src/services/cal/token.ts`) + Google template links, injected only
  into daily reminders (`src/services/reminders/scheduler.ts`). No whole-plan export,
  no OAuth, no chat trigger. (A whole-plan export was prototyped on an unmerged
  session branch in June; master never got it.)
- **Strava**: full OAuth + webhook + backfill stack (`src/services/strava-*.ts`,
  `src/routes/strava-auth.ts`). Offered at onboarding completion via
  `buildOnboardingStravaOffer` (`src/services/strava-connect.ts`) and via
  "connect strava" intent in `process-incoming.ts:860`. **Broken for new users**
  since Strava's paid API gating (2026-06-28).
- **Garmin**: founder-only Python sidecar → `garmin_wellness` table → readiness
  context line in `src/memory/retrieve.ts`. Not athlete-facing.
- **Token encryption pattern**: AES-256-GCM encrypted token persistence exists for
  Strava (`src/services/strava-connections.ts`) — directly reusable for Google OAuth.

## Design principles (the 10x-design-engineer bar)

1. **Taps over typing.** Every closed question becomes a Telegram inline keyboard.
   Typing stays available (buttons are an accelerator, never a wall). WhatsApp
   falls back to numbered text options.
2. **Never interrogate.** Keep the single-message fitness intake (it converges in
   1–3 turns). Preference taps are three quick single-tap questions, each answerable
   in under 2 seconds. Total added time: ~10 seconds.
3. **Confirm back, then celebrate.** After extraction, MARP mirrors a compact profile
   card ("Here's what I've got…") so the athlete sees they were heard. Completion has
   a moment: the coach introduces itself *in the persona the athlete just picked*.
4. **Everything is changeable later.** "Make it shorter", "go easier on me",
   "/settings" — preferences are living state, not a one-shot form.
5. **The calendar is the plan's body.** A training plan the athlete never sees again
   is a dead plan. Whole plan → calendar, every session with a description that coaches
   (what, why, pacing), updated when the plan adapts.

## Scope

### 1. Telegram interactive layer (foundation)

- `telegram-send.ts`: optional `replyMarkup` (inline keyboard) param; keep 4096-char
  splitting (markup goes on the last chunk).
- `src/webhooks/telegram.ts`: handle `callback_query` updates — `answerCallbackQuery`
  immediately (stops the spinner), then route the callback `data` (≤64 bytes,
  namespaced like `pref:coach:balanced`) into `processIncomingMessage` as a synthetic
  inbound message. Idempotency via existing `claimMessage` on `callback_query.id`.
  Also edit the original message's keyboard away (`editMessageReplyMarkup`) so stale
  buttons can't be double-tapped.
- `deliver.ts` / channel router: `send(contact, text, opts?: {choices?: Choice[]})`.
  Telegram renders buttons; WhatsApp renders "Reply 1, 2 or 3" numbered text.
- New `src/services/messaging/choices.ts`: Choice type, callback-data codec,
  text-fallback rendering, and lenient text matching ("hard", "1", "the hard one").

### 2. Coach preference capture (the three questions)

New onboarding section `preferences` after `complete`-worthy extraction, before pivot:

- **Coaching style** — the relationship: 🎯 **Director** (coach dominates —
  makes the calls, flags the risks, pushes) / ⚖️ **Partner** (decide together,
  direct but encouraging) / 🤝 **Companion** (friend at your side — supportive,
  patient). Stored as `coach_prefs.coaching_style: "director"|"partner"|
  "companion"` (matcher accepts hard/balanced/easy as synonyms).
- **Reply style** — default verbosity: **Short** (essentials) / **Balanced**
  (a solid paragraph when it matters) / **Long** (full reasoning, the why).
  `coach_prefs.reply_style: "short"|"balanced"|"long"`. A DEFAULT, never a cap:
  explicit in-message requests and context always override (see Strategy
  decisions).
- **Training style** — how the plan pushes: **Easy** (conservative progression, extra
  recovery) / **Balanced** (classic periodisation) / **Hard** (ambitious load, fewer
  down-weeks) / **Aggressive** (maximum safe stimulus; MARP warns about injury risk
  and requires an explicit confirm tap). `coach_prefs.training_style`.

Each question: one short message + one inline keyboard, fired sequentially (next
question sent on answer). Defaults if skipped/ignored: balanced / medium / balanced.
All three stored in `athleticHistory.coach_prefs` (memory retrieval picks it up free).

### 3. Holistic intake

One additional free-text step (LLM-extracted, skippable via a "Skip" button):

> "Last one — I coach the whole athlete, not just the runs. Anything else I should
> know? Other sports you do (gym, cycling, football…), what your work/family load
> looks like, how you sleep — and anything you want me to help with beyond training
> (nutrition, sleep, strength, race-day strategy, headspace)."

GDPR framing (EU market — stress/sleep/mental are health-adjacent data): the
question explicitly says it's optional, purpose-bound, and deletable — "totally
optional — I only use this to shape your training, and you can ask me to forget
it anytime." Covered by the existing consent gate; athlete deletion already wipes
`athleticHistory` wholesale.

Extracted into `athleticHistory`:
- `other_sports: [{sport, frequency_per_week?, note?}]`
- `life_context: {work?, stress?, family?, sleep?, note?}`
- `coach_topics: string[]` (nutrition | sleep | strength | mental | race_strategy | …)

These feed: plan generator (cross-training scheduled around football night, load
budget respects life stress), weekly evaluation, and the coach's proactive topics.

### 4. Personality actually changes behavior (prompt wiring)

- `src/memory/retrieve.ts`: render a `## Coach calibration` block from `coach_prefs`
  into memory context (style descriptor + hard length budget per reply_style).
- `prompts/synthesizer.md`: obey the calibration block — relationship rules per
  coaching_style (Director/Partner/Companion), default length per reply_style
  (short: essentials; balanced: ≤1 solid paragraph; long: full reasoning).
  Length is a default, NOT a cap: an explicit in-message request ("explain in
  detail", "keep it short") and inherent content needs always override the
  stored preference. Safety and injury content is always exempt.
- `prompts/plan-generator.md`: training_style modifiers (progression rate, down-week
  cadence, quality-session density; "aggressive" gets an explicit injury-risk note in
  plan notes) + schedule around `other_sports` + respect `life_context`.
- Post-onboarding preference edits: natural language ("be more brief", "go harder")
  handled via a lightweight intent in `process-incoming.ts` that updates `coach_prefs`
  and confirms in one line. `/settings` (Telegram command) re-fires the three keyboards.

### 5. Google Calendar integration (the plan's body)

Two layers, offered right after the plan is built (and on demand via chat):

**Layer A — whole-plan ICS + subscription feed (ships first, works everywhere):**
- `src/services/cal/export.ts`: build one VEVENT per non-rest session for the entire
  plan. Floating wall-clock times at the athlete's preferred time (preferred_time
  mapping morning 07:00 / lunch 12:00 / evening 18:00, or reminderPrefs.time_local).
  `SUMMARY`: `Run — Tempo 8km (W3·D2)`. `DESCRIPTION`: full session description +
  "Why" reasoning + week theme + pacing cue — a description that coaches.
- **Subscription feed (webcal)**: the same route served as a *stable per-athlete
  subscription URL* (`webcal://…/cal/plan/:token.ics`, long-lived athlete-scope
  token, revocable). Athlete subscribes once in Google Calendar ("From URL") or
  Apple Calendar; when the plan adapts, the feed updates on the next poll
  (Google ~12-24h, Apple configurable) — "stays in sync" with zero OAuth, zero
  token lifecycle, zero Google Cloud app. One-shot .ics download stays available
  for import-preferrers.
- ICS staleness policy: after any plan change, the coach mentions it in the
  confirmation ("your calendar feed will update within a day; want a fresh file
  now?").
- Chat trigger: deterministic `looksLikeCalendarExportRequest` branch in
  `process-incoming.ts` ("add my plan to my calendar", "calendar export", …) →
  reply with subscribe URL + .ics link + one-line per-platform hint.
- Post-plan offer: after `buildPlanForRunner` / BYO ingest, append a calendar offer
  with an inline button.

**Layer B — Google Calendar OAuth (the real integration):**
- Reuse the Strava connect architecture wholesale: magic-link start route
  (`/auth/google/start?token=…`, 5-min HMAC token), OAuth callback, AES-256-GCM
  encrypted token storage (new `google_connections` table mirroring
  `strava_connections`), scope `https://www.googleapis.com/auth/calendar.events`.
- On connect: insert every plan session as a Google Calendar event (batch), with the
  same rich descriptions, a stable private extended property (`marp_session_uid`) per
  event for idempotent upsert.
- On plan change (adjust/regenerate): resync — upsert changed sessions, delete
  removed ones. Hook into plan save in `src/services/plan/storage.ts`.
- Disconnect: "disconnect calendar" intent → revoke token, optionally delete MARP
  events (ask with buttons).
- Ops prerequisites (eyes open): `calendar.events` is a Google *sensitive scope*.
  In **Testing** publishing status, refresh tokens expire after **7 days** —
  resync dies silently weekly. In production-unverified, users see a full-screen
  "Google hasn't verified this app" warning (poison for a GDPR-conscious EU
  audience). Real verification needs a privacy policy, homepage, and a review
  cycle measured in weeks. PR 4 is therefore **gated**: build only after the
  webcal feed (Layer A) proves insufficient AND the Google verification
  prerequisites (domain, privacy policy) are in place. GDPR: tokens AES-256-GCM
  at rest, events + tokens deleted on athlete deletion.

### 6. Integrations offer (Strava out, honest menu in)

- Remove `buildOnboardingStravaOffer` from the onboarding completion path.
- "connect strava" intent now replies honestly: Strava's API went paid for developers;
  MARP reads runs via Garmin (coming soon), GPX file upload (works today), or manual
  check-ins. Existing connected Strava athletes (founder) keep working — webhook/ingest
  code stays; only the *offer* dies.
- Manual/GPX check-ins get first-class copy — the coach *asks* about the run and
  extracts from a pasted description or screenshot; "no watch integration" must not
  read as "the coach can't see my runs."
- Garmin waitlist taps set `athleticHistory.garmin_waitlist_at` — a real demand
  signal feeding the Open Wearables (KER-47) prioritization, not a placebo button.
- New integrations offer at onboarding completion (buttons):
  **📅 Google Calendar** (offered to everyone, actually fires post-plan) ·
  **⌚ Garmin** — gated by `GARMIN_ATHLETE_ALLOWLIST` env (founder-only today; others
  see "waitlist — I'll ping you when it's live" and we set a flag) ·
  **📄 GPX upload** — mentioned as always-available.
- `docs/gtm/features.md`: update Strava section to reflect reality.

### 7. Copy pass (the obsession part)

Rewrite the onboarding arc as one narrative: welcome (promise + how long this takes),
intake, profile-card mirror ("Here's what I've got — anything wrong?"), three taps,
holistic question, plan pivot (now with buttons), plan reveal, calendar offer,
first-persona greeting. Every message ≤ Telegram-comfortable length, emoji as
signposts not confetti, progress cues ("2 taps left").

## NOT in scope

- WhatsApp interactive message templates (Twilio quick-replies) — text fallback only.
- Apple Calendar OAuth (no public API; ICS/webcal covers it).
- Official Garmin API / athlete-facing Garmin onboarding (waitlist capture only).
- Ripping out Strava code (kept for existing connections + possible future paid tier).
- Locale/i18n of onboarding copy.
- Web dashboard settings UI (chat-first; dashboard later).

## Migration

Existing athletes (founder + test users): no backfill form. First message after deploy
from an athlete without `coach_prefs` triggers a one-time "quick calibration" (the three
keyboards). Defaults apply until answered.

## Success metric

Onboarding completion rate (started → prefs answered → plan created → calendar
connected), measured via the E10 funnel events. Target: ≥80% of athletes who pass
consent reach a generated plan; ≥50% connect a calendar.

## Strategy decisions (resolved at final gate, 2026-07-05)

- **Launch channel = Telegram** (founder decision). Telegram is the product
  improvement/testing surface — low cost to iterate. WhatsApp launch happens
  later, when legal/business/product readiness lands; Twilio quick-replies stay
  in TODOS.md until then. The recorded "launch on WhatsApp number" strategy is
  superseded for the build phase.
- **Ingestion strategy**: plan sequencing stands (PRs 1-4). Interim ingestion =
  the existing python-garminconnect sidecar (cyberjunky/python-garminconnect) —
  founder data flows today. At commercial readiness, move to a scalable source:
  Strava paid API, Garmin official API, Open Wearables, or Terra. The Garmin
  waitlist signal (garmin_waitlist_at) feeds that decision.
- **Quality bar, not launch trigger**: onboarding is polished to real-user
  production quality even while the only athlete is the founder. No formal beta
  trigger attached; launch remains a separate decision gated on legal/business
  readiness.
- **Coaching style = relationship model** (founder refinement): the question is
  who the coach IS to the athlete —
  🎯 **Director** (coach dominates: makes the calls, flags the risks, pushes) ·
  ⚖️ **Partner** (decide together, direct but encouraging) ·
  🤝 **Companion** (friend at your side: supportive, patient).
  Stored enum: `coaching_style: "director"|"partner"|"companion"`; lenient
  matcher accepts hard/balanced/easy as synonyms. Q1 and Q3 are differentiated
  by stem ("How should I coach you?" vs "How hard should the plan push?").
- **Reply length is a DEFAULT, never a cap** (founder refinement): `reply_style`
  sets the default verbosity; context and explicit requests always override.
  An in-message ask ("explain in detail", "quick answer") beats the stored
  preference — the coach must NEVER give a short answer to an explicit request
  for a long explanation, and vice versa. Some content is inherently long
  (plan explanations) or short (confirmations) regardless of preference.
  Changeable on the go ("be more brief" / "give me more detail"). This override
  rule is a REQUIRED golden-transcript eval case: short-pref athlete asks
  "explain in detail why this tempo pace" → must get the full explanation.

## Test plan (sketch — eng review to expand)

- Unit: choices codec, callback routing, ICS export (golden-file), token scope,
  Google upsert idempotency (mocked), pref extraction, text-fallback matching.
- **Persona differentiation (golden transcripts)**: the same athlete message
  rendered under all 3 coaching styles and all 3 reply lengths; pass bar = a
  blind reader can match transcript to style. If prompts can't pass, the style
  options are settings theater — fix prompts before shipping the question.
- Flow: onboarding end-to-end with taps, with typed answers, with skips; pivot via
  button and via "(b)"; pref change mid-conversation; calendar offer → export;
  plan adjust → resync.
- Manual: real Telegram bot run-through (founder), Google OAuth happy path, .ics
  import on iPhone + Google Calendar web.

## Rollout

1. PR 1: Telegram interactive layer + preference capture + prompt wiring + Strava
   offer removal (biggest UX win, no external deps).
2. PR 2: Holistic intake + plan-generator integration.
3. PR 3: Whole-plan ICS + chat trigger + post-plan offer.
4. PR 4: Google Calendar OAuth + resync.

---

# Appendix A — Scripted happy-path transcript (the copy IS the product)

Conversation design rules: one job per message · no message over ~10 lines ·
button labels ≤ 24 chars, max one emoji, emoji as signpost never decoration ·
free text always beats buttons · persona voice activates THE MESSAGE AFTER the
coaching-style tap and never switches off · never default silently — say it.

1. **[Athlete]** /start
2. **[MARP]** Privacy notice (existing copy) + `[✅ I'm in]` `[No thanks]`
   (decline path: existing CONSENT_DECLINED_REPLY + archive — unchanged)
3. **[MARP — intake, welcome merged into first line]**
   > You made it. I'm MARP — a running coach in your pocket. Give me ~2 minutes
   > and I'll build a plan around *you*, not a template.
   > Answer what you can in one message (skip anything):
   > 1. Name, age, sex · 2. Height & weight · 3. Your goal — race + date +
   > target time, or just "get fitter" · 4. Typical week — km/week, longest
   > recent run, recent race times · 5. Days per week you can train ·
   > 6. Injuries or niggles · 7. Which city you're in
4. **[Athlete]** free text (one message, partial answers fine)
5. **[MARP — mirror card]**
   > Here's what I've got:
   > 🎯 Berlin Half — 21 Sep · target 1:45
   > 🏃 ~32 km/week · longest 14 km
   > 📅 4 days/week · evenings
   > 🩹 Left knee — occasional
   > 📍 Berlin
   > `[✓ All correct]` `[✏️ Fix something]`
   (Fix → free text → re-extract → re-mirror, max 2 loops, then "I'll fix
   details as we go — tell me anytime." Corrections honored in ANY section.)
6. **[MARP — Q1, coaching style = relationship]**
   > How should I coach you?
   > 🎯 **Director** — I make the calls, flag the risks, push you
   > ⚖️ **Partner** — we decide together; direct but encouraging
   > 🤝 **Companion** — a friend at your side; supportive, patient
   > `[🎯 Director]` `[⚖️ Partner]` `[🤝 Companion]` `[You decide, coach]`
7. **[MARP — persona NOW ON, Q2 reply length, demonstrative descriptors —
   each option is written AT that length]**
   > Good. I call it, you run it. Next — how much do I say by default?
   > `[Short — like this]`
   > `[Balanced — a solid paragraph when it matters]`
   > `[Long — the full why behind every session]`
   > `[You decide, coach]`
   > (Default only — ask for more or less anytime and I follow the ask.)
8. **[MARP — Q3, training style]**
   > Last tap — how hard should the plan push?
   > `[🌱 Easy]` `[⚖️ Balanced]` `[🔺 Hard]` `[🔥 Aggressive]`
   > `[You decide, coach]`
   (Aggressive → confirm: "Aggressive means fewer down-weeks and load that
   bites. Injuries end seasons. Still in? `[Yes — all in]` `[Go Hard instead]`")
   ("You decide, coach" anywhere → "I'll start balanced — say 'harder' or
   'shorter' anytime and I adjust." Never silent.)
9. **[MARP — holistic]**
   > One more — I coach the whole athlete, not just the runs. Anything else I
   > should know? Other sports, work/family load, sleep — and anything you want
   > help with beyond running (fueling, sleep, strength, headspace). Totally
   > optional — only used to shape your training, deletable anytime.
   > `[Skip →]`
10. **[MARP — reflect back, in persona]**
    > Noted. Football Tuesdays stays — I plan around it, not against it. Kids
    > and rough sleep mean recovery is the constraint. Won't pretend otherwise.
11. **[MARP — pivot, buttons]**
    > Your plan. Two options:
    > `[📋 I have one — coach me on it]` `[🛠 Build mine from scratch]`
12. **[MARP — build wait state]**
    > Building it around Berlin Half — 4 days, knee-safe, football-proof.
    > About a minute.
    (>90s → one progress ping. BYO branch: ingest, then converge at step 13.)
13. **[MARP — plan reveal, in persona, at chosen length]**
    > Done. 11 weeks, 4 days/week, peak 48 km. Week 1 starts Monday — 4
    > sessions, longest 12 km. First hard truth: your 1:45 needs tempo
    > discipline, not hero long runs. Full plan below.
14. **[MARP — calendar close (the next step, not an epilogue)]**
    > Want this in your calendar? Every session, with the why baked in — and it
    > updates itself when the plan changes.
    > `[📅 Add to my calendar]` `[Later]`
15. Reminder-time buttons ride the existing REMINDER_PROMPT beat (E3).

Variant beats (specified, copy at PR 1): re-entry after >12h mid-flow (one-line
recap + resume: "Welcome back — profile's saved, two taps left, then your
plan."); one nudge at ~24h mid-flow silence, then stop; interruption (question
mid-flow → answer it in persona, then re-ask current question once); migration
quick-calibration (answer the athlete's actual message FIRST, then offer:
"Also — 3 taps and I coach exactly the way you like. `[Set my style]`
`[Later]`"); strava-honest; Garmin waitlist; markup-400 numbered-text fallback.

# /autoplan REVIEW — Phase 1 (CEO)

## Step 0A — Premise Challenge

- **P1: Explicit style selection improves the coach.** Competitor-validated (CoachX
  ships 8 coaching styles; Runna's questionnaire onboarding is its most-praised
  feature). Explicit control also builds trust vs opaque inference. ACCEPTED.
- **P2: Telegram inline keyboards are the right interaction upgrade.** Standard
  Telegram bot practice; taps beat typed "(a)/(b)". Text stays as fallback so
  WhatsApp and typed replies keep working. ACCEPTED.
- **P3: Strava must leave the offering.** Verified: Strava paywalled its API
  2026-06-28; offering it to new users is a dead end. Code stays for the founder's
  existing connection. ACCEPTED.
- **P4: Google Calendar OAuth (not just ICS) is worth building now.** Challengeable:
  OAuth adds a Google Cloud app, token lifecycle, and GDPR surface for a pre-launch
  user base of ~1. Mitigation: phased (ICS ships first in PR 3, OAuth in PR 4), and
  the build-then-launch strategy says build the full backlog before launch. ACCEPTED
  WITH PHASING.
- **P5: Garmin stays founder-only with waitlist capture.** Honest; unofficial API
  can't be offered publicly. ACCEPTED.

## Step 0B — Existing Code Leverage

| Sub-problem | Existing code leveraged |
|---|---|
| Preference storage | `athletes.athleticHistory` JSONB — zero migration, memory context picks it up automatically |
| Coach behavior wiring | `src/memory/retrieve.ts` context builder — add one rendered block |
| Whole-plan ICS | `src/services/cal/build.ts` per-session ICS internals; `cal/token.ts` extended with plan scope |
| Google OAuth | `src/routes/strava-auth.ts` magic-link flow + `strava-connections.ts` AES-256-GCM token storage — copied pattern |
| Resync hook | `src/services/plan/storage.ts` save path |
| Integrations offer copy | `strava-connect.ts` offer-builder pattern |
| Chat intent trigger | `looksLikeStravaConnect` pattern → `looksLikeCalendarExportRequest` |
| Callback idempotency | existing `claimMessage` |

Nothing is rebuilt. The June whole-plan-export prototype (unmerged session branch,
checkpoint under merge 805a221) can be consulted but master is the base.

## Step 0C — Dream State

```
CURRENT STATE                    THIS PLAN                       12-MONTH IDEAL
One-size-fits-all coach voice;   Personalized persona (3×3×4     Coach auto-adapts persona from
text-only Telegram; dead         prefs); tap-based onboarding;   athlete behavior; multi-sport
Strava offer; calendar links     holistic athlete model;    -->  plan engine; Open Wearables
buried in reminders         -->  plan lives in the athlete's     ingestion (KER-47); two-way
                                 calendar; honest integrations   calendar sync; dashboard mirror
```
Every element moves toward the ideal; nothing is throwaway (choices layer, prefs
schema, and google_connections all carry forward).

## Step 0C-bis — Implementation Alternatives

```
APPROACH A: Full stack as planned (4 sequential PRs)
  Effort: L (human ~2 weeks / CC ~1-2 days)   Risk: Med
  Pros: meets every stated requirement; each PR independently shippable; reuses
        Strava OAuth + ICS + JSONB patterns
  Cons: 15-20 files touched; Google Cloud app setup is an external dependency
  Reuses: strava-auth pattern, cal/build, athleticHistory, claimMessage
  Completeness: 10/10

APPROACH B: Minimal viable — typed preferences, ICS only, no keyboards, no OAuth
  Effort: S (human ~2 days / CC ~2 h)   Risk: Low
  Cons: fails the stated goal (tap UX, Google Calendar integration); onboarding
        stays "(a)/(b)" typing
  Completeness: 5/10

APPROACH C: LLM-inferred preferences (no explicit questions), ICS only
  Effort: M   Risk: High (opaque, unverifiable, contradicts explicit user direction)
  Completeness: 4/10
```
**RECOMMENDATION: A** — highest completeness; B and C fail explicit requirements.
Auto-decided (P1 completeness; not close — mechanical, not taste).

## Step 0D — SELECTIVE EXPANSION analysis

Complexity check: ~15-20 files, 4 new modules — over the 8-file smell threshold,
justified by 4 independently shippable PRs; the choices layer is shared
infrastructure, not incidental complexity. Minimum core = PR 1 alone.

Expansion candidates (auto-decided per blast-radius rule):
- **E1 Pivot buttons** — already in plan scope (§7). IN SCOPE.
- **E2 /settings command** — already in plan scope (§4). IN SCOPE.
- **E3 Reminder-time capture via buttons** (reuse choices layer for the
  post-plan reminder question: Morning of / Night before / No thanks + time
  quick-picks) — blast radius (reminders/prefs.ts), <5 files, <1d CC. ADDED.
- **E4 Consent gate button** ("I agree ✅" / "No thanks") — consent.ts, tiny. ADDED.
- **E5 Profile-card confirm button** ("All correct" / "Fix something") — explicit
  part of §7 copy pass. IN SCOPE (made explicit).
- **E10 Onboarding funnel observability** — log events (onboarding_started,
  prefs_answered, pivot_chosen, calendar_connected) so drop-off is visible.
  Blast radius, <1d. ADDED (zero-silent-failures directive).
- **E6 Proactive check-in frequency preference** — proactive-messaging scope,
  outside blast radius. DEFERRED to TODOS.md.
- **E7 Language/locale question** — i18n scope. DEFERRED to TODOS.md.
- **E8 Two-way calendar sync** (athlete moves event → plan adapts) — watch
  channels + conflict resolution, own project. DEFERRED to TODOS.md.

## Step 0E — Temporal Interrogation (decisions resolved NOW)

- HOUR 1: Callback taps route through `processIncomingMessage` as canonical text
  equivalents (a tap on "Hard" behaves exactly like typing "hard") — one code path
  for taps and typing, LLM and deterministic branches both work.
- HOUR 2-3: Preference questions are new onboarding sections in `OnboardingMeta`
  (`preferences` → `holistic`); if the athlete types something unrelated
  mid-question, answer it, re-ask once, then apply defaults and move on.
- HOUR 4-5: ICS uses floating wall-clock times (consistent with existing
  `cal/build.ts` — no VTIMEZONE complexity); Google events use timed events with
  the athlete's IANA timezone. Resync deletes only events carrying the
  `marp_session_uid` extended property — never touches non-MARP events.
- HOUR 6+: Lenient-matcher tests, resync idempotency tests, Strava-reply copy
  review, golden-file ICS test.

## Step 0F — Mode

SELECTIVE EXPANSION (autoplan override), Approach A confirmed.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | Intake | DX review (Phase 3.5) skipped | Mechanical | P3 | API/webhook mentions are internal implementation; no developer-facing surface | Running DX review on a consumer chat product |
| 2 | CEO 0C-bis | Approach A (full stack, 4 PRs) | Mechanical | P1 | 10/10 completeness; B/C fail explicit user requirements | B (typed-only), C (inferred prefs) |
| 3 | CEO 0D | E3 reminder-time buttons added | Mechanical | P2 | Blast radius (choices layer reused), <1d CC | Leaving reminder capture typed-only |
| 4 | CEO 0D | E4 consent button added | Mechanical | P2 | Tiny, in radius, first-touch UX consistency | — |
| 5 | CEO 0D | E10 onboarding funnel events added | Mechanical | P1 | Zero-silent-failures directive; drop-off must be visible | — |
| 6 | CEO 0D | E6/E7/E8 deferred to TODOS.md | Mechanical | P2/P3 | Outside blast radius (proactive messaging, i18n, two-way sync) | Adding them now |
| 7 | CEO 0E | Taps = canonical text through one pipeline | Mechanical | P5 | One code path; explicit over clever | Separate callback state machine |
| 8 | CEO 0E | Whole-plan ICS keeps floating times | Mechanical | P5 | Consistent with existing build.ts; VTIMEZONE adds complexity for zero user benefit | Full VTIMEZONE emission |
| 9 | CEO voices | webcal subscription feed added to Layer A | Mechanical | P1/P2 | Delivers "stays in sync" with zero OAuth; 90% of infra already in plan; blast radius | ICS download only |
| 10 | CEO voices | PR 4 (Google OAuth) gated behind webcal-insufficient + verification prereqs | Taste→gate | P3 | Testing-mode tokens die in 7 days; unverified-app warning is EU-poison; user asked for the integration, so gate not cut | Cutting PR 4 outright (surfaced at final gate) |
| 11 | CEO voices | GDPR purpose-bound framing on holistic intake | Mechanical | P1 | Health-adjacent data in EU market; cheap now, expensive retroactively | — |
| 12 | CEO voices | Golden-transcript persona test added | Mechanical | P1 | 36 pref combos must observably differentiate or the choice is settings theater | Shipping unverified persona prompts |
| 13 | CEO voices | Manual/GPX check-in copy made first-class; waitlist stores demand signal | Mechanical | P3 | Post-Strava replacement must not read as "coach is blind" | — |
| 14 | CEO voices | Success metric (funnel completion targets) added | Mechanical | P1 | E10 events need a target to mean anything | — |
| 15 | CEO voices | Launch-channel + ingestion-priority flagged to final gate | User-facing | — | Strategy calls only the founder can make | Silently deciding either |
| 16 | CEO S1 | Callback data carries a version prefix (`v1:pref:coach:hard`) | Mechanical | P1 | Old buttons in chat history survive copy/schema changes post-deploy | Unversioned callback data |
| 17 | CEO S1 | New chat intents built as extracted modules, not more inline branches in process-incoming.ts | Mechanical | P5 | Hottest file in repo (20 touches/30d); registry pattern stops the bleeding for NEW code without a risky refactor | Full router refactor now (deferred) |
| 18 | CEO S3 | Webcal token: athlete-scope, versioned, revocable ("reset my calendar link") | Mechanical | P1 | Capability URL leaks whole training schedule if forwarded; revocation must exist day 1 | Non-revocable long-lived token |
| 19 | CEO S9 | `CHOICES_UI` env kill switch (buttons → text fallback) | Mechanical | P2 | Matches MESSAGING_CHANNEL pattern; instant rollback of the riskiest UX change without redeploy | Git-revert-only rollback |
| 20 | CEO S6 | Eval suites required before ship: eval:plan, eval:m1, eval:safety, eval:grounding | Mechanical | P1 | synthesizer.md, onboarding.md, plan-generator.md all change — every existing suite is in blast radius | Shipping prompt changes untested |
| 21 | Design | Findings 1,2,4-12 auto-fixed (Appendix A + variant beats + rules) | Mechanical | P5/P1 | Structural conversation-design gaps; copy IS the product | Deferring copy to implementation |
| 22 | Design | Q3 training-style label wording → final gate | Taste | — | User specified "easy/balanced/hard/aggressive"; collision with Q1 labels is a real mis-tap risk | Silently renaming user's words |
| 23 | Eng | Amendments 1-15 accepted as binding (dedup via pending_choice, per-athlete serialization, synthetic bypass, signature contract, message-id persistence, consent-handoff strava strip, prefs_state phase, mandatory webhook secret, ICS folding, feed-time fix + cal_feed_version, matcher guardrails, plain text, enum-constrained pref edits, 8 tests, migration placement) | Mechanical | P5/P3 | Each has one clearly right fix, all code-grounded (5 P1s) | Shipping the plan as originally worded |
| 24 | Eng | HTML parse-mode deferred to TODOS.md | Mechanical | P3 | 400-hazard on every LLM send; formatting is polish | Enabling Markdown now |
| 25 | Gate D2 | Telegram declared launch/test channel; WhatsApp at commercial readiness | User decision | — | Low-cost iteration surface; supersedes "launch on WhatsApp number" for build phase | WhatsApp-first launch now |
| 26 | Gate D3 | Plan sequencing stands; interim ingestion = python-garminconnect sidecar; scalable source (Strava paid/Garmin official/Open Wearables/Terra) at commercial readiness | User decision | — | Founder data flows today; waitlist signal informs the later pick | Re-sequencing PRs 2-4 behind KER-47 |
| 27 | Gate D4 | Real-user quality bar, no formal beta trigger | User decision | — | Polish for real users even while founder-only; launch gated on legal/business readiness | 10-person beta trigger |
| 28 | Gate D5 | Coaching style = Director/Partner/Companion relationship model; stems differentiate Q1/Q3; reply length = default-never-cap with explicit-request override (required eval case) | User decision | — | Founder-refined semantics; kills the "short answer to a long-explanation request" bug class | Hard/Balanced/Easy labels + hard length caps |

## Cross-Phase Themes

**Theme: copy is load-bearing** — flagged independently in Phase 2 (the copy IS
the UI; ~80% was deferred) and Phase 3 (five exact-string signature matchers
break when copy changes; worst case an infinite consent loop). High-confidence
signal: the copy pass is engineering work, not polish — Appendix A + the
signature contract (amendment 4) must land together.

**Theme: the persona must be real, not theater** — flagged in Phase 1 (36 pref
combos with no differentiation evidence = settings theater; golden-transcript
eval added) and Phase 2 (persona must activate at the style tap; silent
defaults break the promise). High-confidence signal: the persona eval and the
activation moment are ship-blockers for PR 1, not nice-to-haves.

## CEO Review — Sections 1-11 (SELECTIVE EXPANSION, auto-decided)

### Section 1 — Architecture

```
                        ┌────────────────────────────────────────────────┐
                        │            Telegram Bot API                    │
                        └───────┬───────────────────────▲────────────────┘
                         webhook│(secret_token ✓)       │sendMessage(+reply_markup NEW)
                                ▼                       │answerCallbackQuery NEW
    ┌──────────────── src/webhooks/telegram.ts ─────────┴──┐
    │ text updates ──────────────► processIncomingMessage  │
    │ callback_query NEW ─► choices.decode ─► canonical    │
    │   (claimMessage on callback id)          text ───────┤
    └───────────────────────────────────────────┬──────────┘
                                                ▼
    ┌──────────────────── process-incoming.ts ─────────────────────────┐
    │ consent ► onboarding(flows/onboarding.ts)                        │
    │           + NEW sections: preferences ► holistic                 │
    │ pivot ► plan ► reminder-prefs                                    │
    │ NEW intents (extracted modules, not inline):                     │
    │   intents/calendar-export.ts  intents/pref-edit.ts               │
    │   intents/integrations.ts (strava-honest, garmin-waitlist)       │
    └──────┬──────────────────────┬─────────────────────┬──────────────┘
           ▼                      ▼                     ▼
    athleticHistory        memory/retrieve.ts     cal/export.ts NEW
    .coach_prefs NEW       + Coach calibration    ► routes/cal.ts
    .other_sports NEW        block NEW              /cal/plan/:token.ics NEW
    .life_context NEW              │                (download + webcal feed)
           │                       ▼                       │
           │             prompts/synthesizer.md     [PR4 GATED]
           │             prompts/plan-generator.md  google-calendar-sync
           └────────────► plan/generator.ts         (mirrors strava-connections)
```

Findings, each auto-decided:
1. **process-incoming.ts bloat** (hottest file: 20 touches/30 days; ~1000 lines of
   inline branches). Adding 3+ more inline intents accelerates the smell. DECIDED
   (#17): new intents land as extracted modules with a thin dispatch line each;
   full router refactor deferred to TODOS.md (out of blast radius).
2. **Callback data versioning**: buttons live forever in chat history; a tap can
   arrive months after the message was sent, across deploys. DECIDED (#16):
   `v1:` prefix, unknown versions answered with a "that menu expired — here's a
   fresh one" toast + re-ask.
3. Coupling: choices.ts is depended on by onboarding, pivot, consent, reminders,
   calendar offer — justified (it IS the platform piece). deliver.ts channel
   interface grows one optional field; WhatsApp path untouched functionally.
4. Scaling: all new paths are per-athlete, low-frequency. First thing to break at
   100x is the webcal feed being polled by calendar providers (one fetch/athlete/
   ~12h — trivial; Cache-Control 1h already the pattern in routes/cal.ts).
5. Single point of failure: Telegram API for sends (existing). answerCallbackQuery
   failure leaves a spinner for 30s — degrade silently, log.
6. Rollback: PR1-3 additive, no destructive migrations; `CHOICES_UI=text` kill
   switch (#19) reverts the tap UX instantly; git revert covers the rest.

### Section 2 — Error & Rescue Map

```
METHOD/CODEPATH                  | WHAT CAN GO WRONG                  | EXCEPTION/SIGNAL
---------------------------------|------------------------------------|------------------
telegram webhook callback branch | unknown/expired callback data      | DecodeError
                                 | duplicate tap (double-click)       | claim conflict
                                 | callback for finished question     | StaleCallback
telegram-send +reply_markup      | 400 Bad Request (markup invalid)   | TelegramApiError
answerCallbackQuery              | network fail → 30s spinner         | fetch error
editMessageReplyMarkup           | message too old (>48h) → 400       | TelegramApiError
onboarding prefs extraction      | athlete types unrelated free text  | no-match
holistic LLM extraction          | malformed JSON / refusal / empty   | JSONParseError
cal/export buildPlanFeed         | no plan / archived athlete         | NotFound
                                 | plan with zero sessions            | empty feed
routes/cal plan feed             | bad signature / expired token      | 403 / 410
Google sync (PR4, gated)         | 401 revoked / 429 / partial batch  | GoogleApiError
---------------------------------|------------------------------------|------------------

EXCEPTION/SIGNAL     | RESCUED? | RESCUE ACTION                        | USER SEES
---------------------|----------|--------------------------------------|-------------------
DecodeError          | Y        | toast "menu expired", re-ask fresh   | fresh keyboard
claim conflict       | Y        | drop silently (idempotent)           | nothing (correct)
StaleCallback        | Y        | toast "already answered"             | toast only
TelegramApiError 400 | Y        | retry as plain text w/o markup, log  | numbered-text Q
answerCallbackQuery ✗| Y        | log + continue (spinner self-clears) | brief spinner
editMessage ✗ (old)  | Y        | ignore (markup stays, taps → stale)  | nothing
prefs no-match       | Y        | answer their message, re-ask once,   | coach responds,
                     |          | then defaults + move on              | question re-asked
JSONParseError (LLM) | Y        | 1 retry, then skip extraction, log,  | onboarding continues
                     |          | continue onboarding                  | (no data lost msg)
NotFound (feed)      | Y        | 404 + plain-text "link no longer     | calendar shows
                     |          | active — message MARP for a new one" | feed error
empty feed           | Y        | valid empty VCALENDAR                | empty calendar
403/410 token        | Y (exists)| same as current routes/cal.ts       | error page
GoogleApiError       | Y (PR4)  | 401→mark revoked + offer reconnect;  | chat notice on
                     |          | 429→backoff; partial→resume by UID   | next interaction
```
No unrescued gaps remain in the design. LLM failure modes (malformed/empty/refusal)
each have a named path — extraction failures NEVER block onboarding completion.

### Section 3 — Security & Threat Model

| Threat | Likelihood | Impact | Mitigated? |
|---|---|---|---|
| Webcal capability-URL forwarded/leaked → training schedule + name exposed | Med | Med | #18: athlete-scope versioned token, revocable via "reset my calendar link"; feed contains sessions only (no phone, no health data) |
| Callback data spoofing (forged webhook POST) | Low | Med | Existing `secret_token` verification on the Telegram webhook (telegram.ts:29) covers callbacks too |
| Prompt injection via holistic free text into synthesizer/plan prompts | Med | Low-Med | Same exposure class as every existing free-text field; eval:grounding + eval:safety suites must pass (#20); no new privilege attached to injected text |
| IDOR on /cal/plan/:token | Low | Med | HMAC-signed token binds athleteId (existing token.ts pattern, constant-time compare) |
| DoS on feed route (unauthenticated) | Low | Low | Invalid signature rejected before DB work; Cache-Control; Railway edge absorbs |
| Google OAuth tokens at rest (PR4) | Low | High | AES-256-GCM (strava-connections pattern); deleted on athlete deletion |
| GDPR: life_context/mental topics = health-adjacent | Med | High (regulatory) | Purpose-bound optional framing (decision #11); consent-gated; wholesale deletion exists |

No new npm dependencies in PR1-3 (ICS built by hand already). PR4 would add
`googleapis` or hand-rolled REST — decide at PR4 time (gated).

### Section 4 — Data Flow & Interaction Edge Cases

Preference tap flow, four paths:
```
TAP ─► decode ─► claim(callback_id) ─► canonical text ─► processIncoming ─► store pref ─► next Q
 │        │            │                                       │
 nil/─► unknown ver ─► duplicate ─► drop                 athlete already
 junk    → toast+re-ask                                  complete → StaleCallback toast
empty/─► free text typed instead ─► lenient match ("2", "hard", "the hard one")
         no match → answer msg, re-ask once, then default
error ─► sendMessage 400 → resend as numbered text (no markup)
```

| Interaction | Edge case | Handled? | How |
|---|---|---|---|
| Preference tap | double-tap | Y | claimMessage on callback_query.id |
| | tap after answering by text | Y | keyboard edited away; stale toast if race |
| | tap on 3-week-old message | Y | version check + expired toast |
| | mid-onboarding redeploy | Y | state in athleticHistory (DB), not memory |
| | athlete ignores buttons forever | Y | defaults after re-ask; never blocks |
| Holistic question | "skip" button / silence | Y | skip = empty extraction, move on |
| | 2000-char life story | Y | LLM extraction; Telegram inbound is fine (no Twilio 1600 cap) |
| Calendar offer | tap but no plan yet (race) | Y | offer only rendered post-plan-save |
| | plan regenerated → old feed | Y | feed reads current plan at fetch time (stateless) |
| | athlete deleted → feed fetch | Y | 404 + inactive-link body |
| Channel switch | prefs set on TG, msg from WA | Y | prefs live on athlete row, channel-agnostic |

### Section 5 — Code Quality

- DRY: whole-plan export MUST refactor-share the VEVENT builder inside
  `cal/build.ts` rather than duplicating fold/escape logic in export.ts. Token
  plan-scope extends `cal/token.ts` (same HMAC helpers). Google magic-link start
  route (PR4) reuses the existing magic-link verify from strava-auth — extract the
  tiny shared helper only when PR4 actually lands (rule of three, gated anyway).
- Naming: `coach_prefs` (snake_case inside athleticHistory, matching existing
  fields like `current_mileage_km_per_week`). `choices.ts` exports `Choice`,
  `encodeCallback`, `decodeCallback`, `renderTextFallback`, `matchFreeText`.
- Complexity: the webhook callback branch stays <5 branches by delegating to
  choices.ts. The lenient matcher is table-driven (per-question synonym map), not
  an if-forest.
- Under-engineering check: reply-length budget must be enforced in the synthesizer
  prompt AND verified by golden transcripts — a prompt-only promise without the
  eval is the settings-theater failure mode.
- Over-engineering check: no state machine library, no new abstraction for
  intents beyond plain modules + one dispatch table. PASS.

### Section 6 — Test Review

```
NEW UX FLOWS: 3 pref taps · holistic Q+skip · consent button · pivot buttons ·
  reminder-time buttons · calendar offer/export · strava-honest reply ·
  garmin waitlist · pref edit via NL + /settings · quick calibration (migration)
NEW DATA FLOWS: callback→canonical text→pipeline · prefs→memory context→prompts ·
  prefs/training_style→plan generator · holistic→extraction→athleticHistory ·
  plan→VEVENTs→feed/download
NEW CODEPATHS: choices codec · lenient matcher · stale/version handling ·
  markup-fallback resend · feed route · funnel events
NEW EXTERNAL CALLS: answerCallbackQuery · editMessageReplyMarkup ·
  sendMessage+reply_markup · (PR4 gated: Google Calendar API)
NEW ERROR PATHS: all rows of the Section 2 registry
```
Coverage map (test type → exists in plan?):
- Unit: choices codec round-trip incl. unknown version (planned ✓); lenient
  matcher table incl. "1"/"hard"/"the hard one"/garbage (planned ✓); ICS
  golden-file for a 2-week plan incl. escaping + empty plan (planned ✓); token
  plan-scope expiry/revocation (planned ✓); prefs extraction (planned ✓).
- Integration: telegram webhook callback → claim → synthetic text (ADD —
  spec: `telegram.callback.test.ts`); markup-400 → text fallback resend (ADD);
  feed route 200/403/410/404 (extend existing cal route tests ✓).
- Flow: onboarding e2e taps-only / typed-only / mixed / all-skipped →
  defaults (planned ✓); pref edit mid-conversation (planned ✓); migration
  quick-calibration for existing athlete (ADD).
- 2am-Friday test: full onboarding with EVERY tap replaced by hostile free text,
  ending with a generated plan + working feed URL.
- Hostile QA test: forged callback data (bad version, other athlete's pref
  namespace, 64-byte garbage) → nothing persists, toast only.
- Chaos test: kill process between pref store and next question send → athlete
  re-messages → onboarding resumes at correct section (state is in DB).
- LLM/prompt changes: synthesizer.md, onboarding.md, plan-generator.md all
  change → **eval:plan, eval:m1, eval:safety, eval:grounding must pass before
  ship** (#20), plus the new golden-transcript persona eval.
- Flakiness: golden transcripts pin model + temperature; ICS golden files use a
  fixed plan fixture (no Date.now in assertions).

### Section 7 — Performance
Feed build: ≤~112 VEVENTs (16wk × 7) string-built per fetch, ~1 fetch/athlete/12h
— negligible. No new DB queries in hot paths beyond existing athlete load; no N+1
(plan lives inside athleticHistory JSONB). Telegram API calls +1 per question
(answerCallbackQuery) — trivial. No caching needed beyond existing Cache-Control.
No issues found (examined: feed route, callback path, prompt-size growth — the
coach-calibration block adds ~10 lines to context, well under budget).

### Section 8 — Observability
- Funnel events (E10): structured one-line logs
  `evt=onboarding_funnel step=<started|prefs_answered|holistic_answered|pivot_chosen|plan_created|calendar_connected> athlete=<id>`
  — greppable in Railway logs (matches existing console pattern; no new infra).
- calendar_connected fires on first feed fetch or ICS download (defined at CEO
  artifact rev 3).
- Callback failures, markup-fallback resends, extraction skips: `console.error`
  with athleteId + section + payload size (never payload content — PII).
- Metric that says it works: funnel conversion in logs; metric that says it's
  broken: `evt=callback_error` rate > 0 sustained.
- Runbook lines (docs/howto): "buttons not showing" → check CHOICES_UI + markup-400
  logs; "calendar feed dead" → token version bumped? athlete archived?
- Debuggability: every pref write logs old→new value; a bug report 3 weeks later
  is reconstructable from evt lines alone.

### Section 9 — Deployment & Rollout
- Migrations: PR1-3 ZERO schema migrations (all JSONB keys). PR4 (gated) adds
  `google_connections` — additive table, zero-downtime.
- Feature flag: `CHOICES_UI` env (#19), default `buttons`; `text` restores
  pre-plan behavior instantly.
- Rollout order per PR: deploy → founder runs a live Telegram onboarding
  (archive+restart own athlete) → check funnel events → done. No staging env
  exists; founder-as-canary is the established pattern.
- Deploy-window risk: callbacks from pre-deploy messages hit new code → version
  prefix handles; new messages during deploy → Railway single-instance restart,
  Telegram retries webhook delivery (getUpdates queue) — no loss.
- Smoke: `curl /health`, send /start to bot, one tap round-trip.
- Post-deploy first hour: watch `evt=callback_error` and markup-400 fallbacks.

### Section 10 — Long-Term Trajectory
- Debt introduced: +3 intent modules (clean); process-incoming dispatch lines
  (+~10 lines to the hot file — contained); prompt complexity grows (calibration
  block) — golden transcripts keep it honest.
- Path dependency: choices layer and coach_prefs schema are the foundation the
  12-month ideal (auto-adapting persona) reads from — auto-adaptation becomes
  "write to the same keys from a new signal source." Feed URL is a public
  contract; version it from day 1 (`/cal/plan/` path can carry v in token).
- Reversibility: 4/5 (feed URLs in athletes' calendars are the only external
  contract; revocation + 404 body handles retirement).
- 1-year question: a new engineer reading plan → prefs → prompts wiring will
  find one pipeline, one storage location, one calibration block. PASS.
- Platform potential: choices.ts serves every future closed question (race-day
  check-ins, weekly retro votes, plan-adjust confirmations).

### Section 11 — Design & UX (CEO-level; deep pass is Phase 2)
- Information arc: promise → intake → mirror card → 3 taps → holistic → pivot →
  plan reveal → calendar → persona greeting. Each message earns its place; no
  step exceeds one screen.
- State coverage: LOADING n/a (Telegram is async chat; existing typing indicator
  covers waits) · EMPTY (skip paths default gracefully) · ERROR (fallback resend,
  toasts) · SUCCESS (persona-voiced completion) · PARTIAL (defaults + changeable
  later). No gaps at CEO altitude.
- AI-slop risk: LOW — the flow is specific (exact questions, exact buttons, exact
  storage), not "add a settings screen."
- Emotional arc: the persona-greeting moment ("the coach introduces itself in the
  voice you picked") is the earned payoff — keep it non-negotiable in PR1.
- Deep design review runs next as Phase 2 of this pipeline.

## Required Outputs (CEO)

**NOT in scope** — see plan §NOT in scope + E6 (proactive check-in frequency,
needs proactive-messaging design), E7 (locale/i18n), E8 (two-way calendar sync),
full process-incoming router refactor (works today; refactor is its own PR),
WhatsApp Twilio quick-replies (fallback text is acceptable; revisit at launch-
channel decision), Google OAuth PR4 (gated, prerequisites listed).

**What already exists** — see Step 0B table (8 reuse points, nothing rebuilt).

**Dream state delta** — after this plan: personalization primitives exist and are
read by every prompt; the plan lives outside chat scroll-back; integrations menu
is honest. Remaining to ideal: auto-adapting persona (reads same keys), source-
agnostic ingestion (KER-47 — the flagged sequencing question), two-way calendar.

**Failure Modes Registry**
```
CODEPATH            | FAILURE MODE            | RESCUED? | TEST? | USER SEES?        | LOGGED?
--------------------|-------------------------|----------|-------|-------------------|--------
callback decode     | unknown/expired version | Y        | Y     | toast + fresh menu | Y
callback claim      | duplicate tap           | Y        | Y     | nothing            | Y
send w/ markup      | Telegram 400            | Y        | Y     | numbered-text Q    | Y
answerCallbackQuery | network fail            | Y        | -     | 30s spinner        | Y
prefs free text     | no lenient match        | Y        | Y     | re-ask then default| Y
holistic extraction | LLM malformed/refusal   | Y        | Y     | flow continues     | Y
feed route          | archived/no plan        | Y        | Y     | inactive-link body | Y
feed route          | zero sessions           | Y        | Y     | empty calendar     | -
funnel events       | log write fails         | Y(no-op) | -     | nothing            | n/a
```
Zero rows with RESCUED=N + silent user impact → no CRITICAL GAPS.

**CEO DUAL VOICES — CONSENSUS TABLE** `[subagent-only — Codex usage-limited until Jul 27]`
```
Dimension                          Claude       Codex  Consensus
1. Premises valid?                 CONCERN→resolved  N/A   single-voice; launch-channel flag → gate
2. Right problem to solve?         CONCERN      N/A   single-voice; ingestion-priority flag → gate
3. Scope calibration correct?      CONCERN→resolved  N/A   OAuth gated, webcal added — resolved in plan
4. Alternatives sufficiently explored? CONCERN→resolved N/A  webcal + hybrid-prefs now scored
5. Competitive/market risks covered?   CONCERN→partial  N/A  §3 holistic model = defensible core; noted
6. 6-month trajectory sound?       CONCERN      N/A   launch-forcing condition → gate
```
Critical findings from the single voice are flagged regardless (per degradation
rule): ingestion priority, launch channel, launch-forcing condition — all at the
final gate.

```
+====================================================================+
|            MEGA PLAN REVIEW — COMPLETION SUMMARY (CEO)             |
+====================================================================+
| Mode selected        | SELECTIVE EXPANSION (autoplan)              |
| System Audit         | hot-file smell (process-incoming), Strava   |
|                      | stash parked, no TODOS.md (created below)   |
| Step 0               | 5 premises confirmed by user; Approach A    |
| Section 1  (Arch)    | 2 issues found (both decided: #16, #17)     |
| Section 2  (Errors)  | 13 error paths mapped, 0 GAPS               |
| Section 3  (Security)| 7 threats assessed, 0 unmitigated High      |
| Section 4  (Data/UX) | 12 edge cases mapped, 0 unhandled           |
| Section 5  (Quality) | 1 DRY constraint set (shared VEVENT builder)|
| Section 6  (Tests)   | Diagram produced, 3 ADDs + eval gate (#20)  |
| Section 7  (Perf)    | 0 issues (feed/callback/prompt examined)    |
| Section 8  (Observ)  | funnel events + runbook lines specified     |
| Section 9  (Deploy)  | kill switch added (#19); 0 migrations PR1-3 |
| Section 10 (Future)  | Reversibility: 4/5, debt: 2 contained items |
| Section 11 (Design)  | CEO-level pass clean; deep review = Phase 2 |
+--------------------------------------------------------------------+
| NOT in scope         | written (6 items)                           |
| What already exists  | written (8 reuse points)                    |
| Dream state delta    | written                                     |
| Error/rescue registry| 13 signals, 0 CRITICAL GAPS                 |
| Failure modes        | 9 rows, 0 CRITICAL GAPS                     |
| Scope proposals      | 9 proposed, 6 accepted, 3 deferred          |
| CEO plan             | written (rev 3, spec-reviewed 8/10)         |
| Outside voice        | Claude subagent (Codex usage-limited)       |
| Lake Score           | 8/8 recommendations chose complete option   |
| Diagrams produced    | 3 (architecture, tap data flow, registries) |
| Unresolved decisions | 3 → final gate (launch channel, ingestion   |
|                      | priority, launch-forcing condition)         |
+====================================================================+
```

# /autoplan REVIEW — Phase 2 (Design)

## Step 0 — Design Scope Assessment
- **0A Initial rating: 6/10.** Plumbing of the conversation (states, errors,
  idempotency) was best-in-class; the conversation itself (copy, button labels,
  persona activation moment) was deferred — for a chat product that's the UI.
  A 10 for THIS plan = a buildable scripted transcript + every state's copy
  specified or explicitly assigned to PR 1 with a quality bar.
- **0B DESIGN.md: none.** De-facto design system = MARP's voice in
  `prompts/synthesizer.md:18` + existing onboarding copy patterns. All persona
  calibration EXTENDS that voice (a style modifier), never replaces it —
  reconciliation rule: reply-length budgets are targets layered on the existing
  "signal density" rule; safety content exempt.
- **0C Existing leverage:** numbered-list intake pattern (keep), mirror-card
  emoji signposting follows existing plan-summary style, PIVOT copy discipline
  (load-bearing exact strings) is the house standard the new copy must meet.
- **0D Focus:** all 7 passes (autoplan).

## Dual voices `[subagent-only — Codex usage-limited]`
Independent design subagent: 13 findings (2 critical, 5 high, 5 medium, 1 low).
Disposition (autoplan rules: structural → auto-fix; taste → gate):

| # | Finding | Severity | Decision |
|---|---|---|---|
| 1 | Persona activates too late; payoff after calendar admin | CRITICAL | AUTO-FIX: persona ON the message after the style tap; reveal in persona; flow ENDS on calendar close; standalone greeting cut (Appendix A) |
| 2 | ~80% of copy deferred to implementer | CRITICAL | AUTO-FIX: Appendix A scripted transcript + variant beats + conversation design rules |
| 3 | Hard/Balanced/Easy label collision across Q1/Q3 | HIGH | TASTE → final gate (user specified these words; recommend keeping stored enum, differentiating stems + adding icons; optional label rename to load language) |
| 4 | Reply-style asked blind | HIGH | AUTO-FIX: demonstrative descriptors (each button written at its own length); question kept (explicit user requirement); synthesizer reconciliation rule added |
| 5 | Abandonment/re-entry unspecified | HIGH | AUTO-FIX: >12h re-entry recap; one 24h nudge then stop |
| 6 | Correction loop unbounded/undefined | HIGH | AUTO-FIX: 2-loop bound; corrections honored in any section |
| 7 | Silent defaulting breaks persona promise | HIGH | AUTO-FIX: "You decide, coach" button + spoken default line |
| 8 | Holistic disclosure never reflected back | MEDIUM | AUTO-FIX: persona reflection beat (step 10) |
| 9 | Plan-build wait has no state | MEDIUM | AUTO-FIX: wait copy + >90s progress ping |
| 10 | BYO branch exits the designed arc | MEDIUM | AUTO-FIX: both branches converge at reveal beat |
| 11 | Migration calibration hijacks real questions | MEDIUM | AUTO-FIX: answer first, offer after |
| 12 | Opening is 3 messages where 1 does the job | MEDIUM | AUTO-FIX: welcome merged into intake first line |
| 13 | Consent decline unspecified | LOW | NO CHANGE: exists (CONSENT_DECLINED_REPLY + archive); pointer added to script |

## Passes 1-7 (0-10, before → after fixes)
1. **Information architecture 7 → 9.** Arc order confirmed right (facts → taste
   → life → plan → calendar); two resequences applied (persona at tap 1; calendar
   as the close). Constraint check: each message shows ≤1 question, ≤4 buttons.
2. **Interaction states 5 → 9.** Added: abandonment/re-entry, correction loop,
   build-wait, interruption, migration beats. State table now: every feature has
   LOADING (wait copy/typing), EMPTY (skip defaults, spoken), ERROR (toasts +
   fallback resend), SUCCESS (persona beats), PARTIAL (resume mid-section).
3. **Journey & emotional arc 6 → 9.** Storyboard: curiosity (/start) → effort
   (one big answer) → being-heard (mirror card) → agency (3 taps) → instant
   payoff (persona flips ON) → vulnerability honored (reflection beat) →
   anticipation (build wait) → reward (persona reveal) → momentum (calendar
   close). The 5-sec visceral = first message promise; 5-min behavioral = taps;
   5-year reflective = "this coach knows me."
4. **AI slop risk 8 → 9.** Chat product; slop here = generic-coach platitudes
   ("Great job! Let's crush your goals! 💪"). Appendix A sets the sentence-level
   bar; golden-transcript eval enforces it. Emoji rule: signpost, one per label.
5. **Design system alignment 6 → 8.** No DESIGN.md (gap logged, /design-
   consultation optional later); reconciliation rule with synthesizer voice
   written; persona = modifier not replacement.
6. **Responsive & accessibility 7 → 8.** Chat inherits platform a11y; our
   obligations specified: labels ≤24 chars (no truncation on small screens),
   emoji never sole meaning-carrier, text fallback = the a11y path (screen-
   reader + keyboard users can always type), tap targets are Telegram-native.
7. **Unresolved decisions.** Resolved in-plan: 12 of 13 findings. Remaining →
   final gate: Q3 label wording (taste). Deferred with rationale: DESIGN.md
   creation (own session).

**Design litmus scorecard** `[single-voice]`: earn-its-place YES (after fixes) ·
taps-over-typing YES · <2s closed questions YES (after demonstrative fix) ·
survives interruption YES (after fixes) · persona payoff buildable YES
(Appendix A) · error copy specified YES (script + variant beats) ·
best-in-class vs Runna/CoachX: architecture YES, sentences now specified —
verdict rides on PR 1 execution + golden-transcript eval.

```
+====================================================================+
|         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
+====================================================================+
| System Audit         | no DESIGN.md; voice = synthesizer.md:18     |
| Step 0               | initial 6/10; all 7 passes                  |
| Pass 1  (Info Arch)  | 7/10 → 9/10                                 |
| Pass 2  (States)     | 5/10 → 9/10                                 |
| Pass 3  (Journey)    | 6/10 → 9/10                                 |
| Pass 4  (AI Slop)    | 8/10 → 9/10                                 |
| Pass 5  (Design Sys) | 6/10 → 8/10                                 |
| Pass 6  (Responsive) | 7/10 → 8/10                                 |
| Pass 7  (Decisions)  | 12 resolved, 1 → gate, 1 deferred           |
+--------------------------------------------------------------------+
| NOT in scope         | DESIGN.md creation; mockups (platform-native|
|                      | chrome — the script IS the design artifact) |
| What already exists  | voice def, intake pattern, pivot copy bar   |
| TODOS.md updates     | 0 new (design debt resolved in-plan)        |
| Decisions made       | 12 added to plan (Appendix A + rules)       |
| Decisions deferred   | 1 (Q3 labels → final gate)                  |
| Overall design score | 6/10 → 9/10                                 |
+====================================================================+
```

# /autoplan REVIEW — Phase 3 (Eng)

## Step 0 — Scope Challenge
Complexity check triggers (15-20 files, 4 new modules) — autoplan override: scope
held, never reduced (P2); mitigation is the 4-PR split + the amendments below.
Search check [Layer 1]: inline keyboards + callback_query + answerCallbackQuery
is the canonical Telegram Bot API pattern (no library needed on Bun/fetch);
webcal ICS feed is the tried-and-true calendar sync path; HMAC capability URLs
match the repo's existing magic-link pattern. No custom-where-builtin-exists
violations. TODOS cross-reference: none of the 5 TODOS block this plan; router
refactor TODO is downstream of PR 1's intent-module pattern. Distribution: no
new artifact types. Completeness: complete version chosen throughout (Lake 8/8).

## Dual voices `[subagent-only — Codex usage-limited]`
Independent eng subagent: 15 findings (5 P1, 8 P2, 2 P3), all code-grounded with
quoted lines. ALL AUTO-ACCEPTED (each has one clearly right fix; none taste).

## ENG AMENDMENTS (binding on implementation — supersede earlier wording)

1. **Double-tap dedup (was WRONG in Section 2/4 tables):** each tap generates a
   fresh `callback_query.id`, so claiming on it only dedupes Telegram redelivery.
   Real mechanism: `pending_choice: {id, question, tg_message_id}` in
   athleticHistory, set when a keyboard is sent, checked-and-cleared atomically
   when answered. Second tap → StaleCallback toast. (`claimMessage` stays, for
   redelivery only.)
2. **Per-athlete write serialization:** all inbound processing (text + callback)
   runs through an in-memory per-chatId promise chain in the webhook layer
   (single Railway instance). Kills lost-update races on the athleticHistory
   read-modify-write (`onboarding.ts:222`, pivot/reminder writes).
3. **Synthetic bypass (amends HOUR-1 decision):** decoded callbacks carry
   `synthetic: true`; the pipeline skips safety triage, binder, flag-detector,
   and run-feeling extraction for machine-generated canonical text (a tap is a
   string we wrote — not a crisis signal, and "hard"/"aggressive" must not
   become spurious flags). Branch logic stays one code path; the free-text
   enrichment layer is bypassed. Tap-to-next-question target: <1s.
4. **Signature contract:** five load-bearing outbound matchers must be updated
   in lockstep with the copy pass: `PRIVACY_NOTICE` (equality),
   `DELETION_CONFIRMATION_PROMPT` (equality), `REMINDER_PROMPT_SIGNATURE`,
   `PIVOT_QUESTION_SIGNATURE` (dies with the pivot rewrite — replace), + new
   pref-question signatures. `deliver()` returns the RENDERED body (with any
   numbered-text fallback suffix); `sendAndPersist` stores the rendered body;
   equality checks become signature-`includes` checks. Regression tests assert
   detection against rendered WhatsApp-fallback bodies.
5. **Telegram message id:** `sendTelegram` returns the id of the chunk carrying
   `reply_markup`; stored in `pending_choice.tg_message_id` — that's what
   `editMessageReplyMarkup` needs. (Today the id is discarded.)
6. **Strava removal completeness:** also strip the Strava offer from
   `buildConsentAcceptedReply` (`consent.ts:74-87` — first post-consent message)
   and reframe onboarding.md's "Strava-aware" section (founder's connection
   keeps working; new-user framing dies).
7. **Prefs/holistic are NOT LLM onboarding sections:** they run as a
   deterministic post-extraction phase driven by process-incoming state
   (`prefs_state`, like `pivot_state`) — no LLM call per tap, no `turn_count`
   increment, no MAX_ONBOARDING_TURNS interaction, not in `VALID_SECTIONS`.
   Onboarding `status` flips `complete` at extraction-complete; the pivot hook
   fires only after `prefs_state: done`.
8. **Webhook secret mandatory:** boot-time assert `TELEGRAM_WEBHOOK_SECRET` when
   `MESSAGING_CHANNEL=telegram` (forged callback_query = deterministic state
   writes otherwise).
9. **ICS correctness:** export adds RFC 5545 75-octet line folding (CRLF+space)
   and strips `\r` from inputs; UID collision (two same-type sessions, one date)
   documented and pinned in the golden file; no SEQUENCE needed for a
   replace-the-world feed (stated explicitly).
10. **Feed times:** DTSTART from `preferred_time` mapping only; `reminderPrefs.
    time_local` used ONLY when `timing === "morning_of"` (night_before is a
    reminder time, not a workout time — bug exists today in `routes/cal.ts:70`;
    fix it here, don't copy it). Revocation state: `cal_feed_version` key in
    athleticHistory, embedded in token, compared by the route.
11. **Matcher guardrails:** lenient matching only for messages ≤25 chars while a
    question is pending; longer text → answer-then-re-ask path. "Corrections in
    any section" = LLM extractor runs on unmatched stray text during prefs
    (costed as PR 1 work, bounded by the 2-loop mirror rule).
12. **parse_mode: stays plain text.** Appendix A bold renders as plain text /
    emoji signposts (existing `sendOne` sends `{chat_id, text}`; enabling
    Markdown makes every LLM-generated send a 400 hazard). HTML parse-mode +
    escaper + 400-retry → TODOS.md.
13. **NL pref edits are enum-constrained:** the pref-edit intent may only write
    one of the closed enum values; anything else routes to normal chat (blocks
    prompt injection into the calibration block).
14. **Tests added** (beyond earlier list): two-distinct-callback-ids-once test;
    concurrent tap+text lost-update test; chunked-send markup-id test; rendered-
    body signature tests; feed with `timezone=NULL` + `night_before` prefs;
    folded/emoji/`\r` golden file; `CHOICES_UI=text` with old callbacks arriving.
15. **Migration calibration placement:** normal-routing branch only, after
    `replyText` is built, suppressed when a safety referral is prepended.

## Test coverage diagram (post-amendments)
```
CODE PATHS                                      USER FLOWS
[+] messaging/choices.ts                        [+] Onboarding e2e
  ├── codec round-trip        [planned ★★★]       ├── taps-only        [planned ★★★]
  ├── unknown version         [planned ★★★]       ├── typed-only       [planned ★★★]
  ├── ≤25-char matcher guard  [amend #11 ★★★]     ├── all-skipped→spoken defaults [★★★]
[+] webhooks/telegram callback branch             ├── interruption mid-Q [planned ★★]
  ├── pending_choice claim    [amend #1 ★★★]      ├── re-entry >12h     [planned ★★]
  ├── distinct-ids-once       [amend #14 ★★★]     └── migration calibr. [planned ★★]
  ├── concurrent tap+text     [amend #14 ★★★]   [+] Pivot buttons + BYO converge [★★]
  ├── markup-400 fallback     [planned ★★]      [+] Calendar offer→feed subscribe [★★]
  └── synthetic bypass        [amend #3 ★★★]    [+] Strava-honest / waitlist [★★]
[+] cal/export.ts                               [→EVAL] persona golden transcripts
  ├── golden file (fold/emoji/\r) [★★★]         [→EVAL] eval:plan/m1/safety/grounding
  ├── empty plan / tz NULL    [★★★]                     (prompt files change)
  └── token scope/expiry/revoke [★★★]
COVERAGE TARGET: every row of the failure-modes registry has a named test.
```

## Performance (Section 4)
Post-amendment #3 the tap path is DB-only (<1s). Feed build trivial (§Phase 1
S7). One added LLM call class: stray-text extraction during prefs (#11) —
bounded, low frequency. No N+1, no new connection pressure. No further issues.

## Worktree parallelization
| Step | Modules touched | Depends on |
|---|---|---|
| PR1 interactive+prefs | messaging/, webhooks/, flows/, prompts/, intents/ | — |
| PR2 holistic+plan-gen | flows/, prompts/, plan/ | PR1 |
| PR3 ICS+feed | cal/, routes/, intents/ | PR1 (offer buttons) |
| PR4 Google OAuth (gated) | new google-*, routes/ | PR3 + gate |
Lane A: PR1 → PR2 (shared flows/+prompts/). Lane B: PR3 core (cal/export,
route, token) can start parallel to PR2 — only its chat-offer wiring waits for
PR1. PR4 gated.

**ENG DUAL VOICES — CONSENSUS TABLE** `[subagent-only]`
```
Dimension                    Claude              Codex  Consensus
1. Architecture sound?       CONCERN→resolved    N/A    amendments 1-3,7 bind
2. Test coverage sufficient? CONCERN→resolved    N/A    amendment 14 binds
3. Performance risks?        CONCERN→resolved    N/A    amendment 3 binds
4. Security threats covered? CONCERN→resolved    N/A    amendments 8,13 bind
5. Error paths handled?      SOUND               N/A    single-voice
6. Deployment risk?          CONCERN→resolved    N/A    amendment 4 binds
```

```
+====================================================================+
|              ENG PLAN REVIEW — COMPLETION SUMMARY                  |
+====================================================================+
| Step 0 (Scope)       | held (P2); Layer-1 patterns confirmed       |
| Section 1 (Arch)     | 7 issues → amendments 1-3,5,7,8,15          |
| Section 2 (Quality)  | 4 issues → amendments 4,6,11,12,13          |
| Section 3 (Tests)    | diagram produced; 8 tests added (#14)       |
| Section 4 (Perf)     | 1 issue (LLM-per-tap) → amendment 3         |
+--------------------------------------------------------------------+
| NOT in scope         | unchanged + HTML parse-mode → TODOS         |
| What already exists  | unchanged (Step 0B)                         |
| Failure modes        | registry amended (#1 dedup mechanism fixed) |
| Test plan artifact   | written to ~/.gstack/projects/…             |
| Critical gaps        | 0 after amendments                          |
| Unresolved           | 0 eng (all 15 findings auto-accepted)       |
+====================================================================+
```

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | ISSUES_OPEN (via /autoplan) | 9 proposals, 6 accepted, 3 deferred; 3 strategy flags → gate |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | UNAVAILABLE | Codex usage-limited until Jul 27 — all voices Claude-subagent-only |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (via /autoplan) | 15 issues, 0 critical gaps — all fixed as binding amendments |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | ISSUES_OPEN (via /autoplan) | score: 6/10 → 9/10, 12 decisions; 1 taste → gate |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | SKIPPED | No developer-facing scope (consumer chat product) |

- **VERDICT:** CEO + DESIGN + ENG CLEARED — plan APPROVED at the final gate (2026-07-05). All four gate decisions resolved by the founder (see Strategy decisions + audit trail rows 25-28). Ready to implement: PR 1 first.

NO UNRESOLVED DECISIONS
