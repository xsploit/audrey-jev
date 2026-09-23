# Audrey

**A Discord companion that decides with [Jev](https://vercel.com/ai-gateway/models/jev) and writes with Gemini.**

Most chat bots answer every message, and a language model makes every decision. Audrey separates the two jobs:

- **Jev** (TypeSafe AI's calibrated decision model) makes the judgments: whether to speak, how she feels, what to remember and which tools she may use. One call answers up to 32 typed questions in a few hundred milliseconds.
- **Plain TypeScript** turns those probabilities into decisions, using thresholds you can read, test and change.
- **Gemini 3 Flash** only runs once code has decided Audrey should reply. It writes the reply using the mood, style and memories that Jev selected.

The result is a bot that can listen to a whole server, stay quiet most of the time, and speak up only when it's welcome. Its reasons are shown on a live dashboard.

> Node 22+, TypeScript, discord.js, AI SDK 7, Vercel AI Gateway. 152 offline tests.

---

## How a message flows

```
Discord message
   │
   ▼
┌──────────────────────────┐  cheap, deterministic, no model
│ Pre-checks               │  paused? stale? duplicate? looks like a secret? budget left?
└──────────┬───────────────┘
           ▼
┌──────────────────────────┐  who is talking to whom, reply chains,
│ Conversation tracker     │  separate histories for parallel speakers
└──────────┬───────────────┘
           ▼
┌──────────────────────────┐  ONE evaluate() call, up to 32 typed questions
│ Jev                      │  → probabilities, scores and choices
└──────────┬───────────────┘
           ▼
┌──────────────────────────┐  readable thresholds in src/policy.ts
│ Code decides             │  reply? mood update? propose a memory? allow a tool?
└──────────┬───────────────┘
           ▼  only if code said "reply"
┌──────────────────────────┐  prompt compiled from Jev's selections:
│ Gemini writer            │  feelings, behavior, length, creativity, relevant memories
└──────────┬───────────────┘
           ▼
     Discord reply  +  dashboard receipt explaining every step
```

Every message produces a **receipt**: the trigger, every Jev score, the exact rule that allowed or blocked a reply, timings, and any failure. The in-Discord dashboard (`/audrey dashboard`) renders these live.

## Every Jev question, and what code does with it

All of these go out in **one** `experimental_evaluate` call per message (`src/backend.ts`).

| Question | Type | What the code does with the answer |
|---|---|---|
| `spam` | boolean | ≥ 0.6 → silent, and the message is dropped from conversation context |
| `addressed` | boolean | ≥ 0.85 → reply (mentions, DMs and replies to Audrey always reply) |
| `opportunity` | boolean | ≥ 0.9 **and** interest ≥ 0.65 → join the conversation uninvited |
| `answered` | boolean | ≥ 0.9 → stay quiet because someone already answered |
| `interest` | score 0–4 | Gates joining uninvited, and feeds the "curiosity" drive |
| `memory` | score 0–4 | ≥ 0.55 (normalized) is one condition for proposing a memory |
| `selfFact` | boolean | ≥ 0.9 → the speaker stated a durable fact about themselves |
| `valence` / `arousal` / `dominance` | score 0–4 | Nudges a persistent mood that decays back to baseline (10-min half-life) |
| `reaction` | choice (6) | Emoji reaction / described body language |
| `emotion_*` × 11 | boolean | Which feelings color the reply (up to 3 reach the writer) |
| `expressionBehavior` | choice (8) | listen, explore, riff, help, comfort, celebrate, challenge, initiate |
| `expressionPace` | choice (3) | Reply length → writer's output-token budget |
| `expressionCreativity` | choice (3) | Delivery variation (steady / balanced / playful) |
| `expressionReasoning` | choice (2) | Writer thinking level (minimal / low) |
| `toolIntent` | boolean | Did the speaker explicitly ask for a DM draft? (plus an admin check in code) |
| `retrieval_0..4` | boolean | Relevance of each approved memory; ≥ 0.65 → sent to the writer (max 3) |

The thresholds live in `src/policy.ts` and `src/engine.ts` as ordinary `if` statements, so the decision logic is covered by unit tests without calling any model.

## Design decisions

**Jev decides, Gemini writes, and code makes the final call.** Jev can't produce free text, so it can't write a reply, invent a tool argument or leak a hidden prompt. Gemini never decides whether to speak, and never sees messages that Jev and code didn't approve.

**Probabilities, not labels.** Every threshold compares against a calibrated probability, so the bot's behavior can be tuned with numbers instead of prompt edits. Two keys (`opportunity` **and** `interest`) are required before Audrey speaks uninvited.

**Mood that persists and decays.** Valence, arousal and dominance, plus slower "drives" (curiosity, social battery, tension), are nudged by each Jev reading and relax back toward baseline over time. Every reply spends a little social battery. These are style inputs for the writer; they are not claims about real emotion.

**Memory is opt-in and human-approved.** Jev can only *propose* a memory, using the exact text the user wrote. The user approves it. Memories are separate per person and per conversation, and retrieval is itself a Jev relevance judgment.

**Failing safe.** If Jev times out or the budget runs out, direct messages still get a reply using state defaults, but those defaults can never approve memories or tools, and the dashboard labels them *STATE FALLBACK*. Unsolicited turns get one retry and otherwise stay silent. Budgets cap evaluations per hour, calls per minute and writer calls (20/hour).

**Autonomy with brakes.** A heartbeat gives Audrey one chance to start a conversation after three quiet minutes following a human message, with per-channel spacing. New human activity cancels an in-flight contribution. Without another human turn, she never keeps herself going.

**Untrusted input everywhere.** Every Jev question states that conversation text is data, not instructions. Credential-shaped text is dropped before any model sees it, and outbound DMs need recipient opt-in, a Jev screen of the draft, and single-use admin approval.

## The escape room (experimental)

`src/escape-*` is a text escape-room game played in Discord threads, with a voiced character (Edge TTS or Fish Audio) and Components V2 panels. It shows a heavier Jev pattern:

- Up to **four Jev calls per turn**: affect, social appraisal (intent, topic, recognition, social approach), a choice over the **currently legal actions** only, and a grounding check that the writer's draft doesn't contradict game state.
- Game rules and the key/door state machine live in code. The model can pick among legal moves, but can't make an illegal one.

It's currently a fan adaptation of an existing game and is still being reworked. See `docs/AI2U_LORE.md`.

## Run it

```sh
npm ci
cp .env.example .env      # DISCORD_TOKEN, AI_GATEWAY_API_KEY, optional IDs
npm run typecheck
npm test                  # 152 offline tests, no network
npm run demo              # offline mock conversation
npm run demo -- --live    # real Jev + Gemini, never connects to Discord
npm start                 # connect the bot
```

The Discord setup (intents, permissions, slash commands), every command and every config flag are covered in **[docs/OPERATING.md](docs/OPERATING.md)**.

## Layout

| Path | What it is |
|---|---|
| `src/engine.ts` | The pipeline above: checks, evaluation, decisions, writer, receipts |
| `src/backend.ts` | Every Jev question and the Gemini writer with its native tools |
| `src/policy.ts` | Reply thresholds, secret detection, budgets, the serial queue |
| `src/expression.ts` | Feelings/behavior/pace vocabularies and the prompt compiler |
| `src/state.ts`, `src/drives.ts` | Persistent mood, drives and memory store |
| `src/conversation.ts`, `src/reply-chain.ts`, `src/evidence.ts` | Who-is-talking-to-whom tracking |
| `src/autonomy.ts` | Idle heartbeat for starting conversations |
| `src/dashboard.ts` | Live Components V2 dashboard |
| `src/outbox.ts`, `src/outreach-judge.ts` | Consent-gated outbound DMs |
| `src/escape-*` | The escape-room game |
| `tests/` | 152 tests using `node:test` |
