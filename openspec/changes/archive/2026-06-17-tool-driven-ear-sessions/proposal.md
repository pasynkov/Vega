## Why

The long-note-mode change (archived 2026-06-17) put session-shape control in a singleton `SessionWatcher` that subscribes to every Deepgram stream and runs Haiku classifiers globally. The result is fragile: stop/intent logic lives outside the domain that actually owns the artefact (notes), every new "stay-listening" feature has to teach `SessionWatcher` about itself, and the in-session graph re-entry contention is hard to reason about.

Instead, the **domain sub-agent** should own its capture session. A tool call from the supervisor (`begin_dictation`, future: `begin_voice_message`, `begin_meeting_capture`, …) opens a long-lived sub-agent loop bound to one Ear session. The sub-agent receives every Deepgram final as a turn input via a push callback, decides per-final whether to keep listening or stop (still via Haiku-class cheap LLM, but invoked from inside its own loop), and persists the artefact when done. The mechanism is generic so other domains reuse it.

## What Changes

- **BREAKING (internal)**: Remove `SessionWatcher`, `HaikuClassifierService`, and the in-session graph re-invocation pattern introduced by long-note-mode. First-final intent classification and per-final stop classification both move into the new sub-agent loop.
- **BREAKING (internal)**: Remove `notes.tools.ts` entries `enable_long_note_mode` / `end_long_note_mode` and replace them with a single notes tool `begin_dictation` that opens a tool-driven session.
- New capability `tool-driven-ear-sessions`: the contract for a domain tool that owns an Ear session for its full lifetime — `EarSessionHandle` (the per-session state shared with the tool), `EarSessionRouter` (which tool, if any, currently owns a given `sessionId`), and the `runSessionAgent({ handle, spec, initialFinal })` runner that drives a sub-agent loop fed by a push stream of Deepgram finals.
- Notes domain gains `begin_dictation`:
  - The tool calls `EarSessionRouter.arm({ ownerSpec: notesAgentSpec, mode: "long_note" })` which sends `arm_capture` to the Ear and reserves the next session for the notes sub-agent.
  - When the fresh Ear session opens, `runSessionAgent` boots a notes-scoped sub-agent. Every Deepgram final is pushed into the sub-agent as the next turn. The sub-agent decides via its own tool calls (`append_text`, `finalize_note(cleanText)`, `discard_note(reason)`) what to do. It chooses to call Haiku internally for the "is the user done?" check; that is no longer a framework concern.
  - The note file is written incrementally — every accepted final is appended to `output/notes/<timestamp>.md` as it arrives — so a crash mid-dictation does not lose the transcript. `finalize_note` overwrites with the cleaned version.
- The first-final intent step (regular utterance → "is this a long note?") moves out of Core into the supervisor as a normal routing decision: with `begin_dictation` exposed as a tool, the supervisor routes there from the user's short opening utterance the same way it routes any other intent. No special intent classifier service.
- `ear-protocol`: no wire-level breaks. `arm_capture`, `session_mode: long_note`, and the ack cue family stay. The `long_note` mode value is reinterpreted as "an Ear session whose endpoint behaviour is controlled by a Core-side tool" — semantics shift, JSON shape does not.
- Safety cap stays: an Ear session owned by a tool still terminates after a hard wall-clock cap if the tool never says "done", to keep a stuck sub-agent from holding the mic forever.

## Capabilities

### New Capabilities

- `tool-driven-ear-sessions`: The framework that lets a domain tool open, own, and close an Ear capture session. Owns `EarSessionHandle`, `EarSessionRouter`, the sub-agent runner that feeds Deepgram finals into a domain-scoped LLM loop, and the safety-cap enforcement.

### Modified Capabilities

- `agent-system`: Add the notion of a session-bound sub-agent variant (a sub-agent invoked from a tool with a streaming-final input channel, distinct from the post-endpoint `handleTurn` invocation). The `AgentSpec` contract itself is unchanged; what changes is which entry points the runtime offers.
- `long-note-mode`: Replace the `SessionWatcher` + `HaikuClassifierService` requirements with delegation to `tool-driven-ear-sessions`. The notes-domain tools requirement is rewritten around `begin_dictation`. Mode-is-immutable and safety-cap requirements stay.
- `vega-core`: Drop `session-watcher` module. Add the `EarSessionRouter` to the session pipeline so the Deepgram-final fanout has a "is this session owned by a tool?" check before going to the default `handleTurn`-on-endpoint path.

## Impact

- **Code (Core)**:
  - Remove `apps/core/src/session-watcher/` entirely.
  - Remove `notes/enable_long_note_mode` and `notes/end_long_note_mode` tool definitions; replace with `begin_dictation` + the three sub-agent-internal tools (`append_text`, `finalize_note`, `discard_note`).
  - Add `apps/core/src/ear-sessions/` (working name) holding `ear-session-router.service.ts`, `ear-session-handle.ts`, `session-agent-runner.service.ts`.
  - `apps/core/src/session/` final/partial dispatch gains a router-aware branch: if the session is owned, finals are pushed to the owner; otherwise existing post-endpoint behaviour stands.
- **Code (Ear)**: Unchanged. `arm_capture`, long_note safety timer, ack cues all behave as today.
- **Specs**: New `openspec/specs/tool-driven-ear-sessions/`. Deltas to `agent-system`, `long-note-mode`, `vega-core`.
- **Persistence**: Notes file format unchanged; what changes is timing — file is appended on every accepted final rather than written once at the end.
- **Out of scope**: New domains beyond notes; voice-message / meeting capture flows; user-visible UX for cancelling a dictation other than the existing tap-to-end gesture; first-final intent classification ceases to be a separate service (it is now a normal supervisor routing decision).
