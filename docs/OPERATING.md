# Audrey — Jev + Gemini Discord playground

A small companion bot, not a replacement for cordforge. Node 22+ (tested on Node 26), TypeScript, discord.js, AI SDK 7.

**Audrey:** warm, observant, dry-witted; late-night coding/music buddy. Brief answers, gentle teasing, curiosity without compulsively joining every conversation. Transparent that she is an AI. Edit `src/personality.ts`.

## What works

- **Discord:** direct @mentions, replies to Audrey (including replies with mention notifications disabled), DMs, slash commands, private prefix controls, optional emoji reactions. Bots/webhooks ignored; no mass mentions.
- **Passive listening:** explicit channel IDs or server IDs in `.env`. `PASSIVE_GUILD_IDS` includes new accessible channels and threads automatically. Direct interactions still work without listing a channel. No bulk historical backfill; explicit same-channel reply ancestors can be fetched individually.
- **Reply-aware context:** actual quoted text + author + age, up to three linked ancestors. Parallel speakers get separate working histories; unrelated activity is labeled background for Jev and excluded from Gemini's writer prompt. Details below.
- **Jev decisions:** spam, direct address, reply opportunity, already answered, interest, memorability, speaker-specific fact, VAD, described reaction, tool intent, and relevance of up to five approved memories. Independent questions share one request; code handles dependent steps.
- **Dynamic expression:** Jev scores 11 described feelings and chooses behavior, length, creativity and reasoning alongside its existing decisions, in one request. The compiler injects up to three feelings, mixed-state rules and low-energy/tension/composure cues. Edit `src/expression.ts`; no generated emotional summaries or additional model dependency.
- **Autonomous participation:** LIVE and proactive by default. A one-minute heartbeat offers Jev one initiation opportunity after three quiet minutes following a human turn in configured passive channels/servers. Opportunities expire after 15 minutes, have a five-minute per-channel attempt spacing, and never perpetuate themselves without another human turn. No unsolicited DM scheduling. New human activity cancels an in-flight idle contribution.
- **Speech controls:** deterministic duplicates, cooldowns, bounded queue, timeouts, shared call budgets and a 20/hour writer budget. Interesting does not mean "must reply". Pause and dry mode also stop autonomous sends. Errors fail silent; inspect status/logs.
- **VAD mood:** valence/arousal/dominance, bounded nudges, ten-minute elapsed-time half-life toward baseline.
- **Fictional drives:** curiosity, social battery, tension; slower twenty-minute relaxation. Battery decreases slightly per sent reply. Style inputs, not claims of biological hormones, real emotions, or psychological diagnosis. Never override permissions.
- **Memory:** off until each user opts in or requests default enablement via `MEMORY_DEFAULT_USER_IDS`, separate per person AND conversation. Jev proposes exact source text to an inbox; only the user can approve it. Explicit `remember` also supported. Last five approved facts form the candidate set; Jev relevance-filters/ranks them, then at most three reach the writer. No cross-user/DM-to-guild retrieval.
- **Diary:** private factual recap of the last eight evaluated decisions, from a bounded in-memory trace. No invented life story or hidden chain-of-thought; no autonomous daily posts.
- **Gemini writer:** `google/gemini-3-flash` with Jev-selected minimal/low thinking, 768/1024/2048 output-token budgets, and Google's recommended temperature 1. Prompt instructions carry creativity and length variation. Known DeepSeek V3 models additionally receive bounded temperature variation; unknown models get only output limits. Incomplete output is rejected. Native AI SDK tools inspect state, recall selected approved memories, and propose a DM for authorized direct requests. No shell, browser, deletion or role-change tools.
- **Outbound DM outbox:** recipients opt in privately. Jev screens a draft; an administrator reviews exact target/text and approves a single-use five-minute proposal. Consent is rechecked immediately before dispatch. Ordinary responses to an incoming DM do not need outreach opt-in.

## Run

### Live experiment center

Run **`/audrey dashboard`** or **`!audrey dashboard`** in a server text channel. The bot owner or a member with Manage Messages can create it. The command creates or reuses one shared Components V2 panel for that channel; it refreshes every ten seconds and resumes after restart. No panel is posted automatically until someone runs the command.

- **Overview:** Discord connection, live/dry/paused mode, current processing stage, latest outcome, VAD/drive gauges, idle scheduler, cooldown and shared runtime budgets.
- **Emotions:** all Jev match scores, the subset selected by the compiler, behavior, pace, creativity and reasoning.
- **Decisions:** mention/reply/passive/idle trigger, welcome/address/interest/spam/answered scores, precise blocking rule, sanitized provider failures, recent event links, and a selector for older events.
- **Prompt:** the actual compiled dynamic expression and whether the writer was invoked, plus output/temperature/thinking settings, selected-memory count, and Jev token usage. Raw conversation, personal memory text and hidden reasoning are excluded.
- **Controls:** Refresh, pause/resume this channel (Manage Messages or owner), and global autonomy on/off (owner only). Autonomy changes are process-local; restart uses `.env`.

**@mentions, replies to Audrey and DMs are not response-gated.** They bypass spam/address/welcome/interest/answered scores and conversational cooldown. A new direct message can repeat the same text; repeated delivery of the same message ID is deduplicated. Jev supplies optional expression selection; failure or exhausted evaluation budget uses current-state defaults and continues to the writer. Fallback cannot approve memory or DM tools, and local defaults are never displayed as Jev scores. Pause, dry mode, credential checks, queue capacity and writer/call limits remain operational controls. Dashboard outcomes distinguish state fallback, policy silence, system blocks, generation attempts and confirmed sends. Receipts retain 50 events per channel until restart or forgetting. Counters measure engine admissions, not billable provider requests.

Panel registration is stored separately in `data/state.json.dashboard.json`. Each panel only renders its own channel; no cross-channel/DM inspection is exposed. Deleted panels are forgotten rather than repeatedly recreated. At most ten panels can be active.

Passive/autonomous Jev timeouts, rate limits and provider 5xx failures receive one retry after 350ms, charged against evaluation and call budgets. Pause/forget cancels it. Direct turns use the writer immediately after the first Jev failure instead of retrying or sending a service-only notice. The dashboard labels this STATE FALLBACK and preserves bounded failure metadata. Raw provider errors are not exposed.

### Start the bot

```sh
cd ~/jev-discord-demo
npm ci
# On a fresh copy only: cp .env.example .env
# Fill .env locally. Never paste real keys into chat or commit them.
npm run typecheck
npm test
npm run demo             # OFFLINE MOCK; no external calls
npm run demo -- --live   # Synthetic Jev/Gemini calls; never connects to Discord
npm run context:demo     # Paid synthetic reply-chain/speaker-separation smoke
npm start               # Connect the real Discord bot
```

`.env.example` and missing runtime flags default to LIVE with proactive participation. Set `DRY_RUN=true` to simulate or `ALLOW_PROACTIVE=false` for reactive-only use. The local profile has mood, drives, memory, reactions and tools enabled. Whole-server passive listening is enabled for one configured test server (`PASSIVE_GUILD_IDS`) only. The owner's memory proposals default ON across conversations; other users opt in. Direct interactions still work in other joined servers. `npm start` reads `.env`, not the example. Stop any old Audrey instance using the same token to avoid duplicate replies.

`npx tsx src/expression-smoke.ts` runs two paid synthetic Jev/writer checks without connecting to Discord or changing saved state. `/audrey status` shows the latest selected feelings, behavior, pace and reasoning level. Console decision records include the Jev expression selection. Provider smoke checks establish request compatibility, not emotional accuracy or live Discord delivery.

Discord developer settings:
1. Use an **application bot token**, never a user token/selfbot.
2. Enable **Message Content Intent** under Bot → Privileged Gateway Intents.
3. Invite with `bot` and `applications.commands` scopes. Minimal channel permissions: View Channel, Send Messages, Read Message History, Add Reactions (optional), Send Messages in Threads if needed. No Administrator permission needed.
4. Set `DISCORD_OWNER_ID` for owner controls in DMs. Server managers can administer the demo in their server. `DISCORD_GUILD_ID` optionally restricts server interactions; blank permits direct interactions in joined guilds. `DISCORD_CHANNEL_IDS` and `PASSIVE_GUILD_IDS` control passive listening only.

When no guild ID is specified, the bot upserts a global `/audrey` command. Global propagation can take time; prefix controls work immediately. A configured guild uses guild-local slash registration. Existing commands with other names are not deleted.

## Try Audrey

Mention **@Audrey** or DM: "I finally shipped the synth prototype."

```
!audrey help
!audrey status
!audrey memory on
!audrey remember I am building a modular synthesizer.
Audrey, what instrument am I building?
!audrey memories
!audrey approve <source-message-id>
!audrey diary
!audrey forget
```

Prefix control responses in server channels are DMed privately; if DMs are closed, use `/audrey` for ephemeral responses. Memory commands apply to the conversation where issued, even if their result arrives by DM.

Managers/owner:

```
!audrey pause
!audrey resume
!audrey mode dry
!audrey mode live
```

Mode is process-global and resets to `.env` on restart. Pause is conversation-specific and persists. Dry-run still evaluates, nudges mood, and stages opted-in memory proposals, but does not generate/send ordinary replies or execute outbound DM sends. Controls themselves still respond.

## Play: Catgirl’s Apartment

A **conversation-first text adaptation of AI2U’s apartment scenario**, hosted by Audrey. The character is **Eddie**. You wake in an unfamiliar living room in apartment 201. The city outside is burning, and a pink-haired catgirl calls herself your girlfriend. You may genuinely not know her.

**Talk normally in your private thread.** Flirt, question her explanations, compare evidence, maintain a believable lie, repair a confrontation, or propose leaving together. There is no command vocabulary to memorize. The Examine menu covers the window, photographs, blue parrot, computer, key and exit; journal entries distinguish observations, records and what Eddie says.

Eddie is cute, playful and possessive. Attachment, trust, suspicion and hurt are separate: flirting can delight her without unlocking the door. Her relationship claim does not assign the player a past. Denying recognition does not reveal a biography or create a journal-certified romance. The lore comes from the meteor warning and correction, her own background, the computer correspondence, the blue parrot and the disturbing hidden room. Source notes and the distinction from the predecessor game are in **[AI2U_LORE.md](AI2U_LORE.md)**.

### Launch

1. Use Node 22+ and install with `npm ci` if dependencies are missing.
2. Configure the existing `.env`: `DISCORD_TOKEN`, `AI_GATEWAY_API_KEY`, `WRITER_MODEL=google/gemini-3-flash`, and `DRY_RUN=false`. Keep real credentials local. Alternatively, an owner/server manager can enable live mode for the current process with `/audrey mode value:live`.
3. In the server text channel where you want to start, give Audrey **View Channel**, **Send Messages**, **Create Private Threads**, **Send Messages in Threads**, and **Read Message History**. Keep Message Content Intent enabled and invite with `bot` + `applications.commands`. Private threads require a normal server text channel, not a forum, announcement channel or DM. Moderators with appropriate permissions can still view private threads.
4. Stop the old Audrey process, then run `npm start` from this project. Run only one bot process against these state files. Startup upserts `/escape` alongside `/audrey`; a configured `DISCORD_GUILD_ID` registers immediately in that guild, otherwise global command propagation may take time.
5. Run **`/escape`** in that text channel. It creates a private thread, adds you, posts the opening, and displays the scene panel. It resumes an active attempt of the current scenario. An attempt from the replaced scenario is closed and retained for reference, then a fresh apartment is created.

Try: **“Who are you? Where am I?”**, **“I don’t know you.”**, **“Why is the city burning?”**, or a clever pretext to get her to open the door. Current attempts persist across restarts. Older scenario records cannot enter the new model context; `/escape` starts a clean opening for them.

### Controls and presentation

| Control | Effect |
| --- | --- |
| Ordinary text | Speak to Eddie or attempt an action; one turn at a time |
| Examine… | Inspect an available object and let Eddie react |
| Journal / How to play | Private evidence and instructions; no turn spent |
| Inventory | Shows whether you actually have the apartment key |
| Use key / Open door / Step outside | Optional controls using the same state checks as free-form actions |
| Automatic voice clip | Eddie's spoken dialogue accompanies the text reply in the private thread |
| `/escape action:status` | Recover the panel, last response and thread link; unarchive an accessible session |
| `/escape action:end` | End your attempt, including from the parent channel if the thread disappeared |
| `/escape action:forget` | Delete local game state, claims and history; use inside an old ended thread to forget that attempt |
| Play again | Start a fresh private thread after an ending |

Components V2 containers, text displays, buttons and selects are enabled by default. Set **`ESCAPE_COMPONENTS_V2=false`** and restart for traditional embeds with the same controls. A mode change creates a fresh panel rather than trying to convert a V2 message back into an embed. No art assets or external web app are required.

### Real mechanisms, free-form pretexts

The key's holder, the door's **locked → unlocked → open** state, whether Eddie is blocking the threshold, and whether you have crossed it are authoritative JSON state. You can obtain the key by persuasion or an opening created through roleplay, then use it. **You can also persuade or trick Eddie into opening the door herself**, without ever holding the key. Agreement to leave together is stored. The text adaptation resolves the departure through the stairs/lobby as the ending after you cross the open threshold.

Calls, visitors, medical scares and other improvised stories are conversational pretexts for Jev to judge—not separate phone, health or rescue simulations. They can make her believe something, become concerned, stop guarding the key or open the door. The game does not invent a reception puzzle or declare a pulse reading to negate the player's roleplay. A convincing story can produce a real opening; simply declaring possession of the key or a completed escape cannot bypass the actual key/door checks.

The language model extracts up to four explicitly described key/door attempts in order. Code resolves them with Eddie's selected action and stops a sequence when a prerequisite fails. Unlocking alone leaves the door closed; opening alone leaves the player inside. Brief physical narration is authored from those results. **All NPC speech is generated**, including the opening greeting, threats, stabbing reactions, backing down and final remarks. The writer returns JSON containing only `speech`. Grounding checks cover core state and invented shared history. Repeated or rejected drafts get one regeneration attempt with repair context. If speech remains unavailable, the resolved action is preserved and an out-of-character status is shown; there is no scripted character-response fallback. The knife can only be lowered if it is currently raised.

Five ending cards cover leaving alone, leaving together, a lethal confrontation, an unresolved long morning, and ending the attempt yourself. There is no wall-clock deadline: sessions survive restarts and Discord thread archival. The scenario closes after 60 resolved turns if no other ending is reached.

### How the game works

- Reuses Audrey's existing Jev VAD/reaction and memory-relevance evaluator with authored fictional scenario context, `nudgeMood`, fictional drives, bounded exact-text memories, and the configured Gateway/Gemini dialogue stack. The everyday companion's personality restrictions are kept separate from this explicitly fictional role.
- A parallel Jev appraisal identifies the player's attempted action, credible plans, contradictory claims and de-escalation. After affect updates, code builds the legal action set; a second-stage Jev decision chooses among those actions. The writer performs that decision.
- **Code owns reality.** Model text cannot unlock a door, create clues, kill the player or award success. Routine mechanics and new evidence live in the scene panel and journal. Chat contains generated dialogue and brief factual action narration. Outcome cards and action facts are authored; Eddie's words are not.
- A successful negotiation needs trust and a credible proposal. A coherent unverified rescue story can enable deception; contradictions can revoke that belief. A meaningful plan to leave together can also work through attachment and trust, without mandatory clue collection. Jev may still hesitate or ask for reassurance.
- **Eddie can stab the player for angering her**, not just in self-defence. Jev's interpretation of insults, rejection, betrayal and aggression builds persistent anger. At high anger, stabbing becomes available; at her breaking point she attacks rather than endlessly warning. There is no required two-warning sequence. Each resolved stab removes one of three abstract health points; zero produces the knife-death ending. Calming reduces anger and can make lowering the weapon available. An open door can still permit escape, including getting out wounded. Declared symptoms do not directly change this combat health.
- The game uses its own budgets: **6 model turns/minute and 60/hour across the process**, including generated openings. A base gameplay turn uses up to four Jev requests (affect/relevance, social appraisal, legal-action selection, and grounding when needed), plus two writer-model requests (attempt extraction and dialogue). One rejected/repeated draft may add a replacement writer/check pair. Independent assessments run in parallel. Timeouts, rate limits and provider 5xx failures get one bounded retry per request. Offline tests do not establish model accuracy or live cost limits.
- Appraisal failures and illegal decisions leave the entire turn unchanged. If only affect evaluation fails, the current affect is retained as the target. A decision-provider outage selects a permitted fallback action; speech still comes from the writer. Writer failure never fabricates an NPC line. Logs record the failing stage, elapsed time, category and HTTP status, never raw provider error bodies, prompts or keys. Repeated speech is detected after normalizing case and punctuation and compared against recent dialogue, including earlier scripted lines still in saved history.
- Resolved state is saved before Discord delivery; after a delivery failure, use status rather than assuming the turn was lost. In-flight turns are invalidated by end/forget and checked against dry-run mode. State files assume a single process; Discord delivery is not a cross-service transaction.

### Persistence and isolation

Game state lives in **`${DATA_FILE}.escape.json`**, normally `data/state.json.escape.json`, separate from companion mood, approved memories and the outbox. It contains up to 24 recent message records, 30 player claims (500 characters each), discovered clues, fictional emotional state, outcomes and recent processed event IDs per attempt. Claims are explicitly unverified game dialogue, not approved personal memories. Only the owning player can advance the session or use its controls.

Active, ended and locally forgotten game threads bypass normal Audrey chat before passive listening, reply-chain fetching or `!audrey` controls. Forgotten sessions retain only a thread-ID tombstone to prevent accidental return to ordinary listening. `/audrey` controls belong outside the game; use `/escape action:end` to stop a game. Forgetting local state does not delete Discord messages, backups or provider logs. Saved files use owner-only permissions and atomic replacement; corrupt state is refused rather than overwritten.

### Verification and source

`npm run typecheck` and `npm test` include deterministic scenario playthroughs for persuasion, deception, escalation/death, de-escalation, illegal model actions, persistence, concurrent turns, end/forget cancellation, ownership, stale controls, budgets, and V2/embed payload serialization. These use mock AI and Discord inputs and do not connect to your server or establish live model accuracy.

`npm run escape:demo -- --live` runs six synthetic turns through the real Jev/Gemini models, beginning with the reported “who are you / where am I” and “I don’t know you” messages, then flirtation, an activity request and apartment-lore questions. Add `--short` for the first four. It costs provider usage but never connects to Discord or reads/writes live game sessions.

The smoke test also generates the greeting. `--combat` tests escalating insults through drawing the knife, stabs and death, with generated speech on every resolved action.

Add `--mechanics` to replay the reported call/medical/police roleplay and then test taking the key, unlocking, opening and attempting to leave. This is a live behavioural smoke check; Eddie can still block a departure. Deterministic tests separately cover successful key-based and NPC-opens-it routes, first-contact recognition, source-lore boundaries and isolation of legacy attempts.

Character/lore references: [official game description](https://store.steampowered.com/app/2880730/AI2U_With_You_Til_The_End/), [Eddie](https://ai2u.fandom.com/wiki/Eddie), [apartment](https://ai2u.fandom.com/wiki/Catgirl%27s_Apartment), [computer records](https://ai2u.fandom.com/wiki/Computer), and [blue parrot](https://ai2u.fandom.com/wiki/Blue_Parrot_Statue). See [AI2U_LORE.md](AI2U_LORE.md) for source qualifications and adaptation boundaries. The modern proprietary prompt is not claimed to be known; the published YAGS prompt belongs to the predecessor.

### Voice: Edge TTS or Fish

**Dial in the voice interactively:** run `npm run voice:lab`, then open **http://127.0.0.1:4174**. The local Voice Lab has a searchable Edge voice catalogue, pitch/speed/volume sliders with exact number inputs, editable sample dialogue, MP3 playback/download, and six recent takes with settings recall for comparison. Add your own reference clip to the separate player; it stays in the browser. Settings and test text persist in that browser; audio takes stay in memory until the page closes. **Copy settings for Audrey** exports the `.env` lines for your chosen voice. Previewing does not change the live bot.

Optional tester environment variables: `EDGE_TTS_LAB_PORT` changes the port, and `EDGE_TTS_REFERENCE_FILE` preloads a specific local WAV/MP3/OGG/M4A reference (up to 10 MB). The tester binds to loopback only and sends text to Microsoft's Edge service when you generate a take.

The tester also has a **Fish S2.1 Free** tab. It sends the exact model header **`s2.1-pro-free`**, with the chosen `reference_id`, emotion-tagged text and MP3 output to `https://api.fish.audio/v1/tts`. The current default reference is `ee4867b6908d41e58ee7736ce4874622`. Put `FISH_API_KEY` in the environment, `.env`, or the ignored owner-only `data/voice-lab.env` file and restart the tester. Keys are never sent to the browser. This mode does not fall back to a different model if the requested one fails. Use `[excited]`, `[laughing]`, `[whisper]` and similar tags in the text; Edge's tuning sliders do not apply to Fish. The take history can compare both providers. `?provider=fish` opens the Fish tab directly. **Copy Fish request** exports a cURL command using `$FISH_API_KEY`, not the credential itself. Previewing alone does not switch the live Discord bot's provider.

**Use Fish in the actual escape game:** set `ESCAPE_TTS_PROVIDER=fish`, supply `FISH_API_KEY`, and optionally set `FISH_REFERENCE_ID` (the reference above is the default), then restart Audrey. The bot also reads the ignored `data/voice-lab.env` file for these settings. It uses exactly **`s2.1-pro-free`**. Jev's current emotion supplies a short delivery tag (playful, warm, sad, softly, low voice or angry); only Audrey's spoken dialogue is synthesized. Both providers use the same automatic native Discord voice-clip path below. Edge's pitch/speed/volume settings apply only when `ESCAPE_TTS_PROVIDER=edge`.

Audrey's spoken dialogue is voiced **automatically with each reply** in the private thread, including the opening. Text arrives first; the native Discord voice clip follows as a reply to that exact text message. There is no Listen button. Discord's native voice-message format forbids text content in the same message, so these are two linked messages in one response. Italic gestures, scene facts, journal text and authored ending narration are not spoken.

Speech generation runs independently, so a slow or failed speech request does not stall text play or roll back a resolved turn. A new turn, end or forget cancels an in-flight voice generation, and stale results are not sent. The bot needs **Attach Files** and **Send Voice Messages** permissions in addition to the normal game permissions.

Install the small CLI once on the bot host:

```sh
uv tool install edge-tts
```

Defaults (configurable in `.env`):

```dotenv
ESCAPE_TTS_ENABLED=true
ESCAPE_TTS_PROVIDER=edge
EDGE_TTS_VOICE=en-US-AriaNeural
EDGE_TTS_PITCH=+26Hz
EDGE_TTS_RATE=+3%
EDGE_TTS_VOLUME=+0%
EDGE_TTS_COMMAND=edge-tts
```

This is **Microsoft's online Edge speech service**, accessed without an Azure API key; it is not offline speech or a cloned voice. Pitch-raised Aria is an approximation of the requested Eddie sound, not a claim that Eddie's exact original voice settings were verified. No voice-reference recording is required. If the bot is started with a different PATH, set `EDGE_TTS_COMMAND` to the absolute installed executable path.

The Edge client currently produces 24 kHz, 48 kbps mono MP3 and has no selectable higher-quality source format. For Discord, **FFmpeg** converts directly from that source to mono **48 kHz, 128 kbps VBR Opus**, with encoder complexity 10, in an Ogg container. This preserves source bandwidth and minimizes extra conversion loss; it does not create higher-resolution source detail. A separate PCM pass measures the duration and a real RMS waveform of at most 256 samples. Uploads explicitly set `audio/ogg`, `duration_secs`, `waveform`, and `IS_VOICE_MESSAGE` as described in [Discord's voice-message docs](https://docs.discord.com/developers/resources/message#voice-messages). Install FFmpeg with libopus support and make it available in the bot's PATH.

Spoken text travels to the selected provider automatically when voice is enabled. Edge receives it over stdin without shell execution; Fish receives it over authenticated HTTPS. Audio is held in memory, not saved to game state or local audio files. One synthesis runs at a time, with ten requests per minute, a 30-second Edge / 45-second Fish synthesis timeout, bounded conversion subprocesses and a 4 MB encoded output limit. Voice messages are Discord attachments and follow Discord's retention. Set `ESCAPE_TTS_ENABLED=false` for text-only replies.

- `src/escape-scenario.ts`: researched apartment premise, clues, character, actions and endings (contains spoilers).
- `src/escape-state.ts`, `src/escape-engine.ts`: isolated persistence and authoritative rules.
- `src/escape-physical.ts`: key ownership, lock/open-door transitions, blocking and threshold crossing.
- `src/escape-backend.ts`: reused affect evaluator, scenario appraisal, constrained decisions and dialogue.
- `src/escape-dialogue.ts`, `src/escape-diagnostics.ts`: writer context, speech extraction/repetition checks and safe model failure handling.
- `src/escape-discord.ts`: private threads, routing, UI and slash controls.
- `src/escape-speech.ts`: bounded Edge TTS subprocess and spoken-line extraction.
- `src/escape-voice-clip.ts`: high-quality Opus encoding, measured duration/waveform and native voice-message payloads.
- `tests/escape.test.ts`: offline behavioural checks.

## Outbound tools

Recipient privately DMs Audrey:

```
!audrey outreach on
# later: !audrey outreach off
```

Administrator:

```
!audrey propose 123456789012345678 | Want to test the synth prototype tomorrow?
!audrey outbox
!audrey send <proposal-id>
```

Or directly ask Audrey to **draft** a DM to a specific Discord user ID. Jev gates the proposal tool, Gemini drafts, and the same outbox enforces consent and approval. No recipient-lookup or member-enumeration tool is exposed to the model. A non-admin cannot gain tools by claiming to be an admin in text. A low-confidence/failed Jev check is not authorization.

Outreach consent is independent of memory. `forget` clears conversational memory, not outreach consent; use `outreach off` to revoke that separately. Each admin can inspect/approve only their own proposals. Drafts expire after five minutes and do not survive a restart.

## Safety and data boundaries

- Incoming processed text, short same-conversation history and relevant approved memories are sent to Vercel/TypeSafe; writer calls also reach the configured text-model provider. Inform participants before enabling passive channels. DMs are still remote API inputs, not end-to-end private local processing.
- Default provider retention applies. Vercel rejected the ZDR option on the tested Hobby account; this demo does not promise zero retention.
- `.env` and state files are owner-readable/writable, not encrypted. `data/` and credentials are gitignored. Rotate keys exposed in chat and replace `.env` values locally.
- Structural context cache: max 64 turns/channel, 1,000 characters/turn, thirty-minute retention, up to 128 cached channels. Each prompt gets at most ten working-history turns within 6,000 text characters, normally from fifteen minutes of the selected conversation. Explicit quoted ancestors may be older. Jev additionally sees up to three background snippets of 220 characters; Gemini does not. A legacy eight-turn/500-character accepted-turn view remains for diagnostics only. RAM caches are filtered/evicted on access, not by a background erasure timer. Persistent memories: max 30 approved + 10 pending per opted-in user/conversation. Mood/drive state persists.
- Likely credentials are skipped by a limited deterministic detector; this is not comprehensive secret detection. Do not send secrets.
- `forget` deletes that user's saved memory and clears the conversation's short context/decision diary, invalidating in-flight shared context. A persisted conversation reset timestamp also blocks re-fetching pre-forget messages as reply ancestors, including after restart. It cannot erase Discord messages, backups, or provider logs. Other users' approved memory remains intact. Default-enabled users retain only an OFF preference keyed by their ID, so forgetting cannot silently re-enable memory next turn.
- Only actual sent/fetched Audrey messages are marked as Audrey turns. Classified spam is removed from the structural cache and does not enter mood or memory. Eligible text skipped by model budgets/errors remains as untrusted provisional context, so absence of a spam judgment is not a clearance. Bare pings and genuine follow-ups are distinct from repeats, but semantic decisions can still be wrong.
- Fixed experimental thresholds, not calibrated promises: spam .6; address .85; answered .9; proactive opportunity .9 + interest .65; memory proposal memorability .55 + self-fact .9; retrieval relevance .65; tool intent .85; outgoing draft clearance .9.
- Defaults: 120 evaluations/hour, 10 top-level evaluation/writer invocations/minute (local `.env`: 20), 20 writer turns/hour; each writer turn can have up to three model steps. Outbox adds max 10 draft checks + 3 send attempts/hour. Budgets are process-local and reset on restart; use the gateway's account spend limit for a hard billing bound.
- Queue capacity ten; messages waiting longer than 45 seconds are discarded. Guild cooldown configurable; DM reply cooldown two seconds. These are a playground's limits, not production fairness/scaling guarantees.
- Outbound actions are not transactional with Discord's network: once a send request is issued it cannot be recalled by a subsequent pause/revocation.

## Reply chains and conversation tracking

- Explicit reply links outrank the latest channel chatter. Audrey retrieves the immediate target and at most two ancestors **in the same channel/thread/DM**, with a 2.5-second wait budget. Outside passive-listening scopes, a non-mention initially checks only the immediate parent to determine whether it is Audrey. No arbitrary channel-history fetch or cross-channel reference following.
- Messages retain stable author IDs, display names, self/other-bot roles, original timestamps, reply links and age in seconds. Same display names do not merge people. Old quoted messages are not treated as newly observed facts.
- Without a reply link, a same-speaker continuation can reuse their recent exchange for three minutes. DMs keep their own conversation scope. Explicitly addressing Audrey leaves a previous human-to-human exchange. These are structural heuristics, not perfect semantic topic tracking: two unthreaded topics from one person can still be ambiguous.
- Direct replies/mentions aimed at another person suppress unsolicited participation, even if Jev's opportunity score is high. An explicit @Audrey or DM overrides that structural addressing guard; other safety gates still apply.
- Missing, forbidden, cross-channel, cyclic, sensitive or forgotten targets are not invented or recovered from stale cache. A partial chain is labeled partial. Timeout stops waiting; an already queued Discord SDK read may still complete in the background, but its late result is not fed into a prompt.
- `/audrey status` shows the latest evaluated context source, working-history count and reply-chain status. Logs record those metadata, not message text.
- `npm run context:demo` exercises synthetic overlapping-speaker, explicit-reply, missing-target and reply-to-another-person cases through the real models. It never connects to Discord. This is a smoke test, not a calibrated accuracy benchmark.

Inspiration inspected (no existing repo modified): cordforge `src/gateway/context.ts` and `src/runtime/conversation-brain.ts` for explicit reply evidence and speaker-scoped working history; mnemo `src/bot/respond.ts` for speaker/time attribution and untrusted evidence boundaries; unicorn-lite `unicorn_lite/discord_context.py` for causal observation separate from policy decisions. Audrey's implementation remains a smaller independent prototype, not a port of their full runtime.

## Files / extension points

- `src/bot.ts`: Discord permissions, routing, commands and execution.
- `src/reply-chain.ts`, `src/conversation.ts`, `src/evidence.ts`: bounded ancestor fetching, structural tracking and labeled model evidence.
- `src/engine.ts`: shared event → decisions → state → writer flow. Future Twitch or voice-transcript adapters can feed `Event` here.
- `src/backend.ts`: Jev rubrics and Gemini native tools. No hand-parsed tool markup; no DeepSeek provider-specific tool continuation code.
- `src/state.ts`, `src/drives.ts`: bounded persistent state and elapsed-time decay.
- `src/outbox.ts`: consent, exact action approval and execution checks.
- `src/personality.ts`: Audrey's voice.
- `src/simulate.ts`: visibly labeled offline mocks or paid synthetic API replay.
- `tests/`: application behavior tests using mocks, not claims about model accuracy.

Cordforge's inspected `src/runtime/discord-dispatch.ts` informed explicit speaker/reply evidence, per-conversation memory boundaries, recording only real replies, mood/reaction separation, and a separate execution layer. No existing repo was modified or wholesale copied.

## Not implemented yet

General-chat voice listening/turn-taking/TTS, Twitch ingestion/batching, images/OCR/perceptual hashes, real VRM animation playback, scheduled unsolicited DMs, per-person affinity/trust learning, a full vector database, automatic memory consolidation/forgetting, narrative diary generation, distillation, or claims of better accuracy than existing local gates. Reaction labels are descriptions plus optional Discord emoji, not actual BVH clips. Escape-game speech remains a separate existing feature.
