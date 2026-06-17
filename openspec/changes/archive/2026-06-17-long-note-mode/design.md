## Context

Today a Vega session is one-shot: user wakes with "Вега…", Ear streams audio while local VAD watches for ~3s of silence, Core stops on the same idea (silence cap 5s from last partial), Deepgram delivers a final transcript, and the supervisor sees that text via `handleTurn` AFTER the session is already closed. The whole interaction = one short utterance → one terminal LLM reply.

Long-form dictation breaks this. The user wants to think mid-sentence. Three-second pauses, sometimes more. That requires:
- a way to know "this is going to be a long note" before letting the silence cap fire
- a way to detect "the user is done" without a fixed silence threshold
- a way for the user to hear what mode they're in and that commands were accepted

Implementation is **deferred until `llm-orchestration-mvp` lands** because it relies on AgentSpec, supervisor, the graph, and a notes domain that change is introducing. This design captures the shape, locks the decisions the user has already made, and leaves the contract details intentionally fuzzy for tightening at implementation time.

## Goals / Non-Goals

**Goals:**
- One additional session mode `long_note`, entered mid-session via an LLM-decided tool call.
- A single primitive on Core (mutable silence cap) and a single message Core→Ear (`SessionModeChange`) sufficient to implement the mode.
- An LLM-driven stop condition that replaces the silence cap for long notes.
- A cue protocol rich enough for the user to distinguish "command done", "command accepted, still listening", and (later) "command in progress / done / failed", without TTS.
- Establish "in-session graph invocation" as a sanctioned pattern reusable by other future tools.

**Non-Goals:**
- TTS reply for any command in this change.
- Hard reliability for intent detection. User accepts that if the trigger phrase wasn't continuous, the session may fall through to the short-note path.
- Tagging, categorisation, or post-processing of saved notes.
- Multi-session batching or note editing flows.
- A fully wired ack_thinking/success/error pipeline (we add the enum values for protocol stability, but only `ack_done` and `ack_continue` get handler code in this change).

## Decisions

### Trigger path: LLM intent classifier on first final, not a second wake-word

Approach: keep the single Porcupine wake (`Вега`). When Deepgram delivers the FIRST final, the new `SessionWatcher` runs a cheap Haiku call: "is this a long note?". On yes, supervisor is invoked through the graph and routes to the notes domain, which calls the `enableLongNoteMode` tool.

Alternative considered: a second Porcupine keyword (e.g. "запиши заметку") that switches mode locally on Ear. Rejected — needs another keyword model, lower flexibility, no semantic understanding (can't catch paraphrases).

### Tool invocation default = through graph

Default tool path on every in-session LLM hook: SessionWatcher → graph → supervisor → notes domain → tool handler. Same path the post-endpoint `handleTurn` uses. Keeps a single mental model for tools.

Alternative considered (NOT chosen now, kept on file): SessionWatcher invokes tool handlers directly via DI, bypassing supervisor. Cheaper, lower latency, but every direct-path tool becomes a separate code path the team has to reason about. Revisit only if measured graph latency for `enableLongNoteMode` is observably worse than acceptable; the threshold for "observably" is "the user notices the Submarine cue lags after they finish the wake phrase".

### Stop detection = Haiku call per Deepgram final, not per partial

In long-note mode, every time Deepgram produces a NEW final, SessionWatcher calls Haiku with the rolling transcript and asks: "did the user finish?". Returns `{stop: bool, cleanText: string}`. On stop, the `endLongNoteMode` tool saves the note and terminates the session.

Why on final and not on partial: partials are unstable (Deepgram revises). A "stop?" call against a partial that gets re-written wastes tokens and risks inconsistent decisions.

Why per-final and not on a fixed timer: aligns LLM cost with user speech; idle silence doesn't burn calls.

### Safety cap is a hard 60s, even in long-note

If Haiku misclassifies or hangs, the Ear's local safety timer terminates the session after 60s from last activity. This is a hard non-negotiable backstop. The Core's mutable silence cap also resets to 60s from the last partial/final to act as a second backstop on the server side.

### No intent grace on Ear

Ear keeps its 3s VAD endpoint behaviour in REGULAR mode. If the user paused too early after the trigger phrase and Ear closed the session before Core could ship `SessionModeChange`, the supervisor sees the short text via the existing `handleTurn` flow and routes to `saveShortNote`. The user will hear `ack_done` (Tink) instead of `ack_continue` (Submarine), which is the audible signal that long-note didn't engage. Acceptable for the MVP; we are explicitly not chasing reliability here.

### Storage = flat Markdown under `output/notes/`

One file per note, named `YYYY-MM-DD_HH-mm-ss.md`. UTF-8, body = `cleanText`. No frontmatter beyond a single timestamp line; we keep schema decisions out of this change. `output/` belongs under the repo root and SHOULD be gitignored — to be confirmed during implementation.

### Cue taxonomy = additive, all values land in protocol now

`CueEnum` gains `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, `ack_error`. Only `ack_done` (Tink.aiff) and `ack_continue` (Submarine.aiff) get Ear-side handler wiring. The rest are present for protocol stability so a later change can wire them without bumping the schema. Existing cues (`wake`/`endpoint`/`error`) and their system sounds (Purr/Pop/Basso) stay.

### Pattern: in-session graph invocation

This change introduces a second entry point to the graph that ISN'T `handleTurn`. SessionWatcher synthesises invocation context (sessionId + current rolling transcript + a hint flag distinguishing "intent check" from "stop check") and invokes the same compiled graph. The graph and supervisor are blind to whether they're running mid-session or post-endpoint — that detail is encoded in the tool the supervisor selects.

Why this matters: future commands ("Вега посмотри что в гитхаб", "Вега запусти поиск") will reuse this. The user accepted this pattern explicitly during exploration. Document it; don't pretend `handleTurn` is the only door.

## Risks / Trade-offs

- [Latency between wake-phrase end and `ack_continue` cue may feel laggy] → Haiku model chosen specifically for sub-second turnaround; if measurements show the graph path adds material delay, the direct-tool alternative documented above is the escape hatch.
- [Haiku misclassifies user intent, both ways] → False negative: user wanted long-note, got short-note → user hears Tink and retries. False positive: user wanted short, entered long-note → user can wait 60s and let safety cap fire, or say "стоп" / "конец заметки" which Haiku's stop-check will catch. Both are acceptable for MVP.
- [Per-final Haiku stop-check costs add up on very long notes] → Costs scale with utterances, not wall-clock; a 5-minute monologue with 50 finals = 50 Haiku calls. Acceptable for personal use. Re-evaluate if used at scale.
- [Concurrent reasoning about `silenceCapMs` mutation under racing partials] → Single-threaded Node + per-session map already serialises. No new concurrency primitives needed.
- [Ear may receive `SessionModeChange` after it has already sent `ear:local_vad` end] → Treat the message as no-op if `activeSessionId == nil`. Core side, the corresponding session lookup will already be gone; tool returns a benign "session no longer active" result without retrying.
- [Saved notes leak into Git history] → `output/notes/` to be added to `.gitignore` during implementation; the path itself is created lazily on first save.
- [In-session graph invocation invites future tools to abuse it] → Document the pattern explicitly in the design and have the change introduce a thin SessionWatcher surface that future hooks plug into, rather than letting each tool re-invent the dispatcher.

## Migration Plan

- No data migration required.
- New cue values in `CueEnum` are additive — older Ear binaries connecting to a new Core would receive an unknown cue and need to ignore it. To be confirmed: whether the Swift decoder fails open on unknown enum values; if not, an "unknown cue" tolerance shim is part of the change.
- `SessionModeChange` is new; Core never sends it unless the long-note tool fires, so older Ear builds without the handler still work for normal sessions.

## Open Questions

- Concrete prompt text for the Haiku intent classifier and the stop-check (drafted at implementation time).
- Should `SessionWatcher` invoke the graph asynchronously (fire-and-forget) or block the audio pipeline (await result before processing next final)? Default: fire-and-forget with per-session lock, but confirm at implementation.
- Path of `output/notes/` relative to the repo root vs. user home — pin during implementation.
- Whether the existing checkpointer (SqliteSaver from `llm-orchestration-mvp`) should record in-session invocations the same way it records `handleTurn`s, or whether they live in a separate audit table.
- How to surface long-note state in the menu-bar status. (Out of scope for behaviour, but the UX hint may make the difference between "felt invisible" and "felt magical".)
