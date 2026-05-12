# Casual Storytelling

How to give a presentation to people who already know you — and won't pretend to be impressed if you start sounding like a TED Talk.

This is the storytelling guide for the room where everyone's already on first-name terms: team standups, internal demos, lunch-and-learns, retros, friend-of-a-friend meetups, hackathon show-and-tells. The stakes are lower, the room is warmer, and the worst thing you can do is overproduce it.

---

## The vibe

You're not performing. You're catching people up.

The room already trusts you. You don't need to earn the next 30 seconds — you need to *not waste* the next 30 seconds. Skip the throat-clearing, skip the "so basically what I want to talk about today is…" and just start.

If a slide makes you cringe to read out loud to your colleagues, cut it.

---

## The five-beat structure

Same bones as the formal version, one fewer act:

```
Start ────────────────────────────────── End
│ Hook │  Context  │  The Thing  │  Caveats  │ Close │
```

| Beat | ~Share | Purpose |
|------|--------|---------|
| Hook | 10% | Get attention without overselling |
| Context | 20% | What we were doing / why this exists |
| The Thing | 50% | The actual content — demo, results, idea |
| Caveats | 15% | What's broken, what's missing, what's weird |
| Close | 5% | Land it, ask for feedback, sit down |

### Hook

One line. Make it true. Make it slightly self-aware.

> *"Okay so I went down a rabbit hole this weekend."*
> *"This started as a one-line fix. It is no longer a one-line fix."*
> *"I have screenshots. They're not good screenshots. Bear with me."*
> *"Quick thing — five minutes, promise."*

If you want a joke or a meme here, fine. *One.* The room will forgive one. They will not forgive five.

### Context

Two or three sentences. What were you doing, why, and what was annoying you. The audience already knows the codebase / product / project — don't re-explain it.

> *"So you know how the deploy script takes forever? Yeah."*
> *"Marketing asked for the same report three times this month."*
> *"I kept getting paged on the same alert at 3am."*

If you find yourself writing a full paragraph here, you're presenting to the wrong audience or the wrong room.

### The Thing

This is the whole point. Demo it, show the numbers, walk through the change, share the finding.

A few patterns that work:

- **The demo.** Open the thing. Click around. Talk over it like you're showing a friend. Don't read a script.
- **The before/after.** Two screenshots. Old one, new one. Let the diff speak.
- **The three things.** "I found three weird things. Here they are." Numbered. Quick.
- **The walkthrough.** Step through the code or the flow. Stop when someone asks a question — questions are good here, they mean people are following.

You can be loose. You can say "wait, hold on, let me find the right tab." It's fine. The room is on your side.

### Caveats

The casual version of "the honest part." Shorter, lighter, but still real.

> *"This works on my machine. I have not tested it on yours."*
> *"There is one edge case and I am choosing not to think about it right now."*
> *"The code is held together with vibes. I'll clean it up before merging."*
> *"This is the third rewrite. Please do not suggest a fourth."*

A bit of self-deprecation lands here. Don't overdo it — you still want them to take the work seriously. The rule of thumb: roast the code, not yourself.

### Close

Ask for what you actually want.

> *"Anyone want to try it? I'll send the branch."*
> *"Thoughts? Roast it."*
> *"Cool, that's it. I'll be in #eng if you have questions."*
> *"If nobody objects in the next 24 hours I'm shipping it."*

No mic drop required. Just stop.

---

## Memes, jokes, and sarcasm

A tiny amount is great. A lot is exhausting.

**Rules of thumb:**

- **One meme per deck.** Maybe. If it's actually funny and actually relevant.
- **Sarcasm in service of a point** — fine. Sarcasm as filler — cut it.
- **Don't punch down.** Not at teammates, not at past-you's code (unless past-you is the only victim), not at other teams.
- **No inside jokes the new hire won't get.** Or if you must, explain it in one line.
- **Animated GIFs:** one, max. Looping motion is distracting and people stop listening to you.

Some examples of the right dosage:

> A retro slide titled **"Things we said we'd fix in Q1"** followed by a slide with a single meme of a dog drinking coffee in a burning room. Then move on. Don't milk it.

> A demo where the test suite is red, and you say "ignore that, it's vibes-based testing." One beat. Continue.

> A status update with a slide that just says **"It's fine. Everything is fine."** as a gentle joke about a known fire. The room laughs once. You go back to the data.

If the joke needs a setup, it's not casual anymore — it's a bit. Cut it.

---

## Slides that work for casual decks

You do not need 30 slides. You probably need 5 to 10.

**Good casual slides:**
- A title slide with the talk title and your name. That's it.
- A "what we were doing" slide. One sentence, maybe a screenshot.
- The demo (which is often *not* a slide — it's the actual product / terminal / dashboard).
- Numbers, if you have them. Big font. No chart junk.
- A "stuff I didn't finish" list.
- A final slide with your handle / channel / "ping me" line.

**Bad casual slides:**
- Agenda slide. Everyone can count to five.
- "About me" slide. They know you.
- A wall of bullet points you read out loud.
- A summary slide that just re-says what you said.

---

## When to skip slides entirely

For a lot of casual presentations, slides are overkill. If you're showing a demo, just share your screen and talk. If you're walking through a code change, open the PR. If you're explaining an idea, draw on the whiteboard.

The deck is for when you need to *anchor attention* on something specific — a number, a quote, a comparison. If the content doesn't need anchoring, ditch the deck.

A good test: if your "slides" are 80% just-the-app, you don't need slides. You need a screen share and a rough outline in your head.

---

## Tone calibration

Read your script out loud. If any line makes you sound like you're trying to win an award, rewrite it. If any line makes you sound like you're roasting your team, rewrite it. The target is: *"I'm telling you something useful, and we both have other meetings."*

A few tone swaps:

| Too formal | Better |
|------------|--------|
| "I'd like to walk you through our quarterly initiative." | "Here's what we shipped this quarter." |
| "We identified an opportunity to optimize the workflow." | "The thing was slow. We made it less slow." |
| "I want to acknowledge the constraints we encountered." | "A few things didn't work. Here's what." |
| "In conclusion…" | "That's it." |

---

## Common mistakes

### 1. Treating it like a keynote
You're not on a stage. Lower the energy. Talk like a person.

### 2. Hiding the boring parts
The casual room *wants* the boring parts. They want to know what didn't work, what you skipped, what you're dreading. Save the polished version for the formal audience.

### 3. Too many memes
Three memes is one too many. Five memes and you've made a Buzzfeed listicle.

### 4. No clear ask
Even casual presentations should end with the audience knowing what you want. Feedback? Approval? Nothing? Say it.

### 5. Pretending you know more than you do
The room knows you. If you bluff, someone will notice in real time. Better to say "I don't know yet" and move on.

---

## A formula that works

```
1. One-line hook that's true.
2. Two sentences of context.
3. Show the thing.
4. Mention what's still broken.
5. Tell them what you want from them.
```

Five beats. Ten minutes max. Sit down.

---

## One more thing

The casual deck is for the room that already likes you. Don't over-engineer it. Don't perform. Don't pretend.

If you'd be embarrassed to show this deck to your team, that's actually a good sign — it means it's honest. Polish it just enough that it's readable, and ship it.

The bar isn't *impressive*. The bar is *useful*.
