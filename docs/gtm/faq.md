# FAQ

Common questions, honest answers. Written for runners considering MARP, not for engineers. If something here disagrees with what MARP actually does, the docs in this directory win.

---

## What is MARP, exactly?

MARP is your personal AI running companion. One ongoing conversation that covers everything a race cycle asks of you — training, mental game, nutrition, injury, recovery, gear — and learns who you are over time so the coaching gets more personal the longer you're with it.

You text MARP in WhatsApp. MARP remembers what you've told it, sees the runs you've done (via Strava or by uploading a file), and walks beside you to your goal.

---

## How is it different from a generic running app?

Most running apps give everyone the same plan and forget the conversation the moment you close them. MARP does three things differently:

1. **Holistic, not specialised.** One companion across six domains. Your injury changes your nutrition advice changes your training plan — automatically.
2. **Learns your story.** Past race cycles become memory you can call back to. Injuries get tracked across weeks. Decisions you've made together stay open until they close.
3. **Proactive, not just reactive.** MARP notices when a race date passes and summarises the cycle. MARP catches new injuries you mention in passing. MARP checks in after long gaps.

The implicit difference: most apps are optimising you for "faster." MARP is optimising you for "still in love with running at the end of the cycle."

---

## Is it a chatbot? An AI? A real coach?

It's AI — powered by Claude (Anthropic's models) under the hood, with structured memory and access to your training data. It's not a human coach, and we don't pretend to be.

What this means in practice:

- MARP is available all the time, including at 11pm when you're spiralling about race day
- MARP can hold deep context across months that a part-time human coach often can't
- MARP refuses to do things a real coach wouldn't either — most importantly, **medical advice**. If you describe pain at ≥4/10 or anything sharp/swollen, MARP defers to a physio. No "push through."

A great human coach you see weekly is still a great coach. MARP isn't trying to replace that. MARP is for the much larger group of runners who don't have one.

---

## How does the memory work?

When you tell MARP something, MARP saves it in structured form — not just in the chat history. For example:

- "My achilles has been tight for three days" → an injury flag with a start date, surfaced in every future reply until you resolve it
- "I'm running Jakarta Marathon in March, goal 4:00" → a race block with countdown math
- "Heading to Bali Friday for a week" → a travel flag for the relevant window

When MARP replies, it pulls from:

- Your profile (name, athletic history)
- Your active flags (open injuries, illnesses, travel, life events)
- Your active race block
- Up to 3 past race cycles' summaries (compounding long-term memory)
- Your last 14 activities (from Strava + uploads)
- Your last 20 messages with MARP

That's why the coaching gets more personal over time. The structure compounds.

---

## What do I need to use it?

- A phone with WhatsApp
- A goal — race, distance, or just a target you're working toward
- (Optional but recommended) A Strava account, so MARP can see your training automatically
- (Optional alternative) Any device that exports GPX files — you can send them directly in WhatsApp

That's it. No app to install, no separate login, no profile to fill out (the profile gets captured during a 3–5 minute onboarding conversation).

---

## What if I don't use Strava?

You can still use MARP. Two paths:

1. **Upload GPX files via WhatsApp.** Most devices (Garmin, Apple Watch, Wahoo, Polar) export GPX. Send the file in chat; MARP parses it and logs it the same way it would a Strava activity.
2. **Describe in text.** "Did a 10K easy at 5:30/km today, HR around 145" works fine for context, though MARP can't verify or build long-term aggregates from it.

Native Garmin Connect, Apple Health, and other direct integrations are on the v1.1 roadmap.

---

## What languages does MARP speak?

English only at v1. Multi-language is on the roadmap once we have real signal of demand from a non-English market.

---

## What does it cost?

v1 is in private beta. No pricing yet.

When pricing lands, expect a free tier (with sensible message-volume limits) and a paid tier (unlimited + future features like the periodised planner). The free tier will be enough for most runners to evaluate seriously.

---

## What can MARP NOT do (yet)?

We don't ship vapor. Here's what's explicitly out of v1:

| Thing | Status | Notes |
|---|---|---|
| Structured 16-week PDF plans | v1.1 | MARP can describe a plan conversationally; the structured output is next |
| Photo / screenshot upload | v1.1 | Garmin / Apple watch screenshots become activities |
| Direct Garmin Connect / Apple Health integration | v1.2 | Strava + GPX cover most cases |
| FIT and TCX file parsing | v1.2 | GPX covers ~95% of devices |
| Live GPS tracking during a run | not planned | MARP isn't a running watch |
| Community / social features | not planned | MARP is 1:1 |
| Multi-language | not planned for v1 | Demand-gated |

---

## Privacy

### What do you collect?

- Your phone number (Twilio gives it to us when you text)
- Whatever you tell MARP in conversation
- Your activities from Strava (if connected) or from files you upload
- Coaching-relevant context you share (injuries, goals, life events, etc.)

What we **don't** collect:
- Real name beyond what you share
- Strava profile data (gender, weight, country, etc.) — only the activity stream
- Location data beyond what's embedded in activity GPS traces
- Payment info (whatever payment system we use handles that itself)

### Where does it live?

In our Postgres database, hosted on Railway. Your Strava OAuth tokens are AES-256-GCM encrypted at rest. Phone numbers are redacted in operational logs.

### Do you sell my data?

No. Never have, never will. This is stated in the privacy notice you see before MARP collects anything from you.

### What about training your AI on my conversations?

We do not use individual user conversations to train AI models. The LLM we use (Claude, by Anthropic) has its own data-handling policies that we follow contractually. We don't ship your data to other AI companies for training.

### Can I see what you have on me?

Yes. We support GDPR Article 15 (right of access). Email support and we'll send you everything we hold on you, as a JSON file, within 48 hours.

### Can I delete everything?

Yes — instantly. Text MARP "delete my account." MARP confirms once. Reply "YES DELETE." Everything is wiped in under a second: messages, activities, flags, race blocks, Strava connection, your profile, all of it.

If you'd rather just disconnect Strava without deleting your MARP history, revoke MARP's access from Strava's side (Strava → Settings → My Apps). MARP gets the deauthorisation notification and stops syncing.

### What if I just want to pause and come back?

That's the default. MARP doesn't have an "active" flag — you can be silent for weeks or months and MARP's still there when you come back. If you're gone for more than 90 days, MARP gently checks in before resuming context (numbers do get recycled by phone carriers; we'd rather verify than hand a stranger your training history).

---

## What if I have a coach already?

Use both. A great human coach you see weekly is irreplaceable. MARP fills the gaps:

- Available between coaching sessions
- Holds context your human coach might forget (most coaches see many athletes)
- Covers domains your coach might not specialise in (mental, nutrition)
- Can answer at 11pm when your coach is asleep

Some runners use MARP and their human coach in parallel and find it works really well — MARP knows the human's plan and works around it.

---

## Can MARP replace a physio / nutritionist / therapist?

No. And we hold this line in the product.

- **Physio** — if you describe pain ≥4/10 or anything sharp/swollen, MARP defers and tells you to see a physio. We don't diagnose injuries.
- **Nutritionist** — MARP gives sport-nutrition guidance grounded in well-established principles. For medical nutrition (eating disorder recovery, diabetes management, etc.), see a professional.
- **Therapist** — MARP can help with race-day nerves, motivation dips, balancing training with life. For clinical mental health issues, see a professional.

This isn't legal hedging; it's the right call. The "mindful" pillar of MARP's positioning means we don't pretend to be things we're not.

---

## How do I get started?

v1 is in private beta. To join:

1. Reach out via [beta signup channel — TBD]
2. We'll share the MARP WhatsApp number
3. Send any message
4. MARP replies with a brief privacy notice
5. Reply YES
6. MARP asks your name + goal race; the conversation begins

Total time from "first message" to "coaching": 3–5 minutes.

---

## Who built MARP?

A small team of runners and engineers. The technology stack is described in `docs/architecture.md` (for the engineering-curious). The product approach — holistic, personal, proactive, mindful — is described in `docs/gtm/positioning.md`.

---

## Related docs

- `docs/gtm/positioning.md` — how we think about MARP
- `docs/gtm/features.md` — complete feature list
- `docs/privacy.md` — the full GDPR posture (for the privacy-curious)
- `docs/prd-v1.md` — what's shipped in v1
