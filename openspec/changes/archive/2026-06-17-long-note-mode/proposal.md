## Why

Currently three silence thresholds (Ear local VAD 3s, Core silence cap 5s, Deepgram utterance_end) cut a session on any pause longer than ~3s. This blocks the user from dictating long notes with thinking pauses. Need a mode where pauses are tolerated and the LLM decides when the note is done.

This proposal is intentionally high-level. Detailed contracts will be refined during implementation, which is deferred until `llm-orchestration-mvp` lands the supervisor, graph, and notes domain primitives this change builds on.

## What Changes

- New session mode `long_note` switchable mid-session. Triggered when an LLM intent classifier flags the user's first utterance as a long-form note.
- Core silence cap becomes mutable per-session (default 5s → 60s in long-note).
- Ear local VAD endpoint disabled in long-note mode; safety timer extended.
- New cue protocol values for backend acknowledgement: `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, `ack_error`. MVP wires `ack_done` and `ack_continue` only.
- New `SessionModeChange` message Core → Ear.
- New Core-side services: `SessionWatcher` (subscribes to partials/finals, dispatches in-session LLM checks) and `HaikuClassifierService`.
- Notes domain (lives in `llm-orchestration-mvp`) gains three tools: `saveShortNote`, `enableLongNoteMode`, `endLongNoteMode`. Storage path `output/notes/YYYY-MM-DD_HH-mm-ss.md`.
- New runtime pattern: **in-session graph invocation**. The graph runs more than once per session in long-note (intent check + per-final stop check), diverging from the `handleTurn`-after-endpoint flow.
- Detailed acceptance criteria, JSON shapes, and per-layer contracts are intentionally left fuzzy at proposal time and will be tightened in design.md and spec deltas during implementation.

## Capabilities

### New Capabilities
- `long-note-mode`: Adaptive silence-cap behaviour and the SessionWatcher/Haiku classifier pipeline that drives mode transitions and stop detection. Owns the in-session graph invocation pattern.

### Modified Capabilities
- `ear-protocol`: Add `SessionModeChange` message and extend `CueEnum` with the ack family.
- `mac-ear`: Handle the new mode message, disable local VAD endpoint in long-note, map new cue values to system sounds, reschedule safety timer on mode change.
- `vega-core`: Make silence cap mutable per session, expose mode/cue control APIs to tools, wire SessionWatcher into the audio pipeline.

## Impact

- Depends on `llm-orchestration-mvp` for supervisor, graph, AgentSpec, notes domain. Implementation blocked until that change lands.
- Affects all three Vega layers (Ear, Core, orchestration). Schema bump in `@vega/ear-protocol` (additive, not breaking — existing cue values stay).
- Adds Anthropic Haiku as a runtime dependency (new LLM client surface, may share config with the supervisor's model client).
- New on-disk artefacts under `output/notes/`. Path needs to exist and be gitignored (or convention-tracked) — decide in design.
- Introduces "in-session graph invocation" as a sanctioned pattern. Once accepted here, future mid-session tool calls (web search, GitHub fetch) reuse it.
