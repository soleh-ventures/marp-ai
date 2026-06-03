# Features — what MARP does for runners

A complete list of v1 capabilities, written for runners, not engineers. Use these descriptions on the landing page, in onboarding screens, in app store copy (when we get there), and in sales conversations.

---

## The four headlines

These are the lead features. If a piece of marketing names only four things, name these.

### Holistic — one companion across everything running asks of you

A race cycle isn't just training. It's also what you're eating, how you're sleeping, the achilles that's been niggling, the trip you've got next week, the head game on race morning, and the shoes you're not sure about. Most apps cover one slice and leave the runner to integrate. MARP covers all of them in one conversation, and **integrates the answers** — when you mention an injury, MARP changes its training advice AND its nutrition advice AND its mental framing for that week.

Six expert domains, one voice: training, mental, nutrition, injury, recovery, gear.

### Personal — learns your story across cycles

MARP isn't a chatbot you start fresh with each time. It remembers:

- Your goal race and how long until it
- Open injuries and when they started
- Trips, work crunches, family events you've mentioned
- Past race cycles — what worked, what broke, what to do differently
- Decisions we made together (rest days, plan changes, race-week calls)

The longer you're with MARP, the more *yours* the coaching gets. Turn 1 is a smart stranger. Turn 50 is the coach who's been with you for months. Turn 500 has seen you through two cycles and knows your patterns better than you do.

### Proactive — notices what you don't ask

Real coaches don't wait for the question. MARP doesn't either:

- When your race date passes, MARP summarises the cycle on its own — what worked, what broke, what to carry forward
- When you mention "my achilles is sore" in passing, MARP captures it as ongoing context, not a one-turn comment
- When you've been quiet for three months, MARP gently checks in before assuming we pick up where we left off (numbers do get recycled; we'd rather check than hand a stranger your history)

### Mindful — built for runners who want to finish the cycle still in love with running

The implicit message of every other running app is "go faster." MARP's implicit message is "reach your goal in a way that's sustainable, joyful, and grounded in who you are."

What that looks like in practice:

- Pain ≥4/10 or sharp / swollen → MARP defers to a physio. Hard rule. No "push through."
- Mental, recovery, and life context are first-class, not afterthoughts
- Warm, plain language — no "crush your goals" theatre
- Privacy by design: your data is encrypted at rest, never sold, deletable anytime by texting "delete my account"

---

## Onboarding

A short conversation when you first sign up. Three or four questions, all in the chat:

- What's your name?
- What race are you training for? When is it?
- What's your background — years running, recent races, weekly mileage?
- Any current injuries or constraints we should plan around?

MARP captures this once and references it forever. You don't fill out a profile. You don't re-enter data. You just answer like you would in a conversation.

After onboarding, MARP offers to connect Strava. Most runners do — it's where everything else gets unlocked.

---

## Daily coaching

The flow once onboarded:

- **Ask anything.** Training, nutrition, injury, mental, recovery, gear. Six domains, all in one chat. MARP routes your question to the right expert(s) internally, then speaks back in one voice.
- **Get a real answer.** Not "consider whether..." — concrete next steps grounded in your data. "Rest today. Your achilles has been bugging you three days running."
- **Tell MARP what happened.** If you ran differently than planned, just say so. MARP updates context.
- **Reply to MARP's questions.** When MARP gives you options ("rest or easy 5K?"), pick one. MARP remembers what you chose.

---

## Strava integration

### What MARP does with Strava data

- Pulls activity details: discipline, distance, duration, pace, heart rate
- Tracks your training over time — the memory layer surfaces your last two weeks of runs in every coaching reply
- Auto-flags long runs (≥16 km running) so MARP can talk about your peak workout
- Syncs new activities within seconds of you uploading to Strava

### What MARP doesn't touch

- Social features (kudos, comments, followers)
- Live GPS during a run
- Your Strava settings
- Your profile photo, bio, weight, gender — anything outside the activity stream

### Disconnecting

Disconnect MARP from Strava's side anytime (Strava → Settings → My Apps). MARP gets a notification and stops syncing immediately. Your existing training data stays in MARP unless you ask MARP to delete your account.

---

## GPX file upload

Don't use Strava? Send any GPX file directly in WhatsApp:

- Garmin Connect exports
- Apple Workouts exports
- Wahoo / Polar / Coros exports
- Any device that produces a `.gpx` file

MARP parses the file, extracts the activity, and confirms what it found: "Got it. Logged a 5.21 km run (28 min)."

GPX coverage is ~95% of modern devices. FIT and TCX file support is on the v1.1 list.

---

## Memory: what MARP remembers about you

You can ask MARP "what do you know about me?" at any time. The answer comes from structured memory:

| Category | What it holds | Where it comes from |
|---|---|---|
| Profile | Name, training history, current weekly volume, recent race times | Onboarding + ongoing chat |
| Goal race | Race name, date, distance, goal time | Onboarding |
| Open injuries / illnesses | What's going on, when it started | Auto-detected from your messages |
| Travel / life context | Trips, work crunches, family events | Auto-detected from your messages |
| Recent training | Last two weeks of activities | Strava + GPX uploads |
| Past race blocks | Narrative summary of how previous cycles went | Auto-generated when a race date passes |
| Decisions we've made together | Choices you've made when MARP offered options | The binder |

You can also export everything we know — see Privacy below.

---

## Privacy

We built MARP to be defensible on privacy by default, not as a marketing claim.

### The privacy notice you see first

Before MARP saves anything (beyond your phone number, which Twilio gives us when you text in), MARP sends one message:

> Hi — welcome to MARP. Before we start, a quick honest note:
>
> I save your messages, runs, and profile so I can coach you over time. It's encrypted, stays with us, and never gets sold to anyone.
>
> You can text "delete my account" anytime — instant wipe, no questions.
>
> Reply YES to start. Reply STOP if this isn't for you.

If you reply STOP, your phone number is archived (not just deleted — *archived*, so the same number can sign up later as a fresh account). Nothing else is kept.

### Your rights

- **Right of access (GDPR Article 15):** ask MARP support and we'll send you everything we hold on you, as a JSON file, within 48 hours.
- **Right to deletion (GDPR Article 17):** text "delete my account" anytime. MARP confirms once and then wipes everything. Takes seconds.
- **Right to rectification:** correct anything by just telling MARP. "Actually my goal race is in November, not October."

### What's encrypted

- Your Strava OAuth tokens are encrypted at rest with AES-256-GCM
- Conversations live in our Postgres database, behind authentication
- Phone numbers are redacted in operational logs

### What we don't do

- We don't sell your data. Not to advertisers, not to research firms, not to anyone.
- We don't share with Strava beyond what's required for the connection itself.
- We don't use your runs to train other models without your explicit opt-in.

---

## Costs and limits

v1 is in private beta. Pricing model TBD. For beta users:

- No message limits
- Up to 60 days of Strava history loaded on connect
- All features in this document available

Once pricing lands, expect:

- A free tier with sensible limits (e.g., ~30 messages/week)
- A paid tier for unlimited + future features (planner, vision, etc.)

---

## Quality-of-life touches

Small things that make the experience feel like a real coach:

- **MARP signals when it's thinking.** If MARP takes more than 5 seconds to reply, you'll see a short note ("Working through this — back in a moment.") so you know it's not stuck. Eight rotating phrases, runner-flavoured.
- **MARP doesn't double-text.** Every conversation has flow. No "Hi! Just checking in!" follow-ups.
- **MARP remembers context across long gaps.** Take a week off, come back, MARP picks up where you left off. Take three months off, and MARP gently confirms it's still you before resuming — phone numbers do get recycled and we'd rather check than hand a stranger your history.

---

## What's not in v1 (coming next)

These are real items in our backlog, ordered by what we plan to ship first:

| Feature | When | Why we deferred |
|---|---|---|
| Periodised training plan | v1.1 | Conversational planning works; structured 16-week output is the next step |
| Photo / screenshot upload | v1.1 | Garmin / Apple watch screenshots become activities |
| FIT / TCX file support | v1.2 | GPX covers most needs |
| Run stories | v1.1 | Narrative recap of each activity |
| Delight touches | v1.1 | Birthdays, streaks, race-week countdowns |

We don't ship vapor; if it's not on this page, MARP doesn't do it yet.

---

## How to try it (placeholder for beta program copy)

Reach out via [beta signup link or contact channel] to get added. Once you're in:

1. Send any message to the MARP number we share with you
2. MARP replies with the privacy notice
3. Reply YES
4. Tell MARP your name + goal race
5. Connect Strava when prompted
6. Start coaching

The whole onboarding takes 3–5 minutes. You're talking to your new coach by the end of it.

---

## Related docs

- `docs/gtm/positioning.md` — how we talk about MARP
- `docs/gtm/faq.md` — common questions
- `docs/privacy.md` — the full GDPR posture (for the privacy-curious)
