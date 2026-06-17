## Context

The previous long-note-mode change (archived `2026-06-17-long-note-mode`, shipped in commit `b483e8d`) put session-shape control in `apps/core/src/session-watcher/`:

- `SessionWatcherService` subscribes to every Deepgram final stream Core opens.
- On the first final, it calls `HaikuClassifierService` to decide "is this a long note?". If yes, it invokes the orchestration graph mid-session so the supervisor can route to `enableLongNoteMode`.
- On every subsequent final in long-note mode, it calls Haiku again to ask "is the user done?". If yes, it invokes the graph again so the supervisor can route to `endLongNoteMode`.

This works but has structural problems:

1. **Logic lives outside its domain.** Stop/intent decisions for a notes session live in a session-pipeline-level service, not in the notes module. Adding a second domain that wants a long-lived capture session (voice messages, meeting capture, …) means teaching `SessionWatcher` about that domain too.
2. **In-session graph re-entry is hard to reason about.** The graph was designed around `handleTurn`-after-endpoint. Running it again mid-session, while a different turn is potentially in flight from the same supervisor, opens concurrency questions the graph contract does not answer.
3. **The classifier is a framework-level singleton.** `HaikuClassifierService` knows about both intent prompts and stop prompts, even though those are notes-specific concerns and may want different models/prompts per domain.

We propose a different shape: each domain that wants a long-lived capture session owns one via a tool. The framework provides only the mechanics — reserving the next Ear session, routing finals to the owning sub-agent, enforcing a safety cap — and the domain provides the AI loop. This is the same pattern the supervisor already uses for post-endpoint turns, just applied to a streaming-final input channel.

The change is internal-only: the `ear-protocol` wire shape, the Mac Ear app, and the `agent-system` `AgentSpec` contract are unchanged. What changes is what runs inside Core between `session_start` and `session_end` for a notes-driven long session.

## Goals / Non-Goals

**Goals:**

- A domain (initially: notes) can request a long-lived Ear session via a normal supervisor-callable tool, and own that session's full final stream + termination decision.
- The framework provides the session-ownership router, the runner that drives a sub-agent loop from streamed finals, and the safety cap. It contains zero domain knowledge.
- The notes domain's "is this user done?" check moves into its own session-bound sub-agent prompt; the framework does not know about Haiku.
- Notes are appended to disk incrementally so a crash mid-dictation does not lose the transcript.
- `SessionWatcher` and `HaikuClassifierService` are removed.
- The mechanism is reusable: adding a second domain that needs a long session is "write an `AgentSpec` with session-bound tools" — no `SessionWatcher` edits.

**Non-Goals:**

- New ear-protocol messages. `arm_capture`, `session_mode`, ack cues all stay as designed.
- New Ear-side behaviour. The Mac Ear app keeps its long-note safety timer and VAD-suppression-on-long-note logic.
- New domains in this change. Voice messages, meeting capture, etc. are out of scope. We only port notes.
- Multi-Ear coordination. One Ear, one in-flight reservation. Same as today.
- A general-purpose pub/sub for transcripts. The router is intentionally narrow (single owner per session) because broadcasting finals creates fan-out problems we do not need.

## Decisions

### Decision 1 — Ownership lives in a single `EarSessionRouter` service, not on the session object

**Why:** Putting `owner?: AgentSpec` on `EarSession` couples the session module to the agent module and forces every session-pipeline change to also touch sub-agent code. A router is a thin lookup table (`Map<sessionId, AgentSpec>` + `Map<deviceId, Reservation>`) that the session pipeline consults at exactly two points (final dispatch, end-of-session). The session module stays oblivious to who owns a session.

**Alternative considered:** Embed ownership in the session object. Rejected — it forces a circular module dependency between `session/` and a new `agent` import; the router-as-lookup-service is what the rest of the NestJS code already does for cross-module wiring.

### Decision 2 — Finals are pushed via direct method call, not via an event bus

**Why:** Concurrency is easier when there is exactly one consumer per session and the path from "Deepgram delivered final" to "sub-agent gets the turn" is a synchronous call into the runner's queue. The runner serialises turns per session; the queue is per-session, not global. An event-bus alternative (`SessionEventBus.emit("final", …)`) would need extra logic to route to the right consumer and to guarantee one-at-a-time processing per session.

**Alternative considered:** A general-purpose `SessionEventBus` so other listeners (logging, metrics) can subscribe. Rejected as YAGNI — metrics already hook the existing Deepgram-final dispatch; they do not need a new bus.

### Decision 3 — First-final intent classification leaves Core entirely

**Why:** With `begin_dictation` as a normal supervisor-visible tool, the supervisor's existing post-endpoint routing handles the "user asked for a long note" case the same way it handles any other intent. The user says "запиши большую заметку", the regular session closes normally on tap/VAD, `handleTurn` runs, supervisor sees the user wants dictation, supervisor calls `begin_dictation`. No mid-session graph invocation, no first-final classifier service.

This means there is no longer any LLM call between `session_start` and `session_end` for a regular (un-owned) session. Regular sessions look exactly like they did before long-note-mode shipped.

**Trade-off:** Latency. With the old design, intent classification fired on the first final, in parallel with the user continuing to speak. With the new design, intent is decided only after the regular session ends. For a fast tap-to-end ("запиши большую заметку" + tap), this adds at most one supervisor turn of latency. For a typical 2-3 second utterance this is negligible. If it becomes a problem we can revisit by adding a fast-path "obvious dictation cue" classifier as a session-bound option on the regular session, but that is explicitly out of scope here.

### Decision 4 — Session-bound tools are real `Tool` objects, not a separate interface

**Why:** Reusing the existing `Tool` abstraction (with DTO validation via `makeTool`) means the LLM sees a uniform tool surface and the existing tool-call error handling already works. The only difference is at the handler-context layer: a session-bound tool's handler receives an `EarSessionHandle` on `ctx`; a non-session-bound tool's does not. Tools that require the handle throw `ToolUsedOutsideSessionError` if invoked without one.

**Alternative considered:** A separate `SessionTool` interface. Rejected — it duplicates the DTO/JSON-Schema/handler pipeline and creates two divergent tool registries. The context-injection approach keeps one registry and adds one type-narrowing check.

### Decision 5 — Sub-agent ends the session by returning a structured release shape, not by calling a separate "end session" hook

**Why:** Tools that end the loop (`finalize_note`, `discard_note`) need to do two things: persist the artefact AND release the session. Doing both inside the tool's handler keeps the contract simple — the tool's return value carries the release signal. The runner inspects the return value; if `{ release: true, reason }` is set, it tears down. No separate hook to forget to call.

**Alternative considered:** A `ctx.releaseSession(reason)` method on the handle. Rejected — easy to forget, and forgetting it causes the safety cap to fire 90 seconds later instead of immediate teardown.

### Decision 6 — Three independent safety caps, all firing on `session_end`

The three caps that can end an owned session:

1. **Core silence cap** (60 s from last transcript) — existing, unchanged. Fires `core:silence_cap`.
2. **`EAR_SESSION_OWNER_CAP_MS`** (90 s wall clock from `session_start`) — new, owner-runner-enforced. Fires `core:owner_safety_cap`. Guards against a runaway sub-agent that keeps appending forever.
3. **Ear-side safety timer** — existing, on the Mac Ear. Independent backstop.

Each cap is independent because each guards a different failure mode (no transcript, runaway sub-agent, lost connection). The runner runs a flush hook on the owning domain before releasing ownership when caps 1 or 2 fire, so the in-progress note file is left on disk in a consistent state.

### Decision 7 — `output/notes/<ts>.md` is opened on first session-bound final, not on `begin_dictation`

**Why:** If the Ear never opens the armed session (e.g. user cancels via OS audio dialog, network drops between `arm_capture` and `session_start`), we should not leave empty `output/notes/` files behind. The notes sub-agent opens the file in `append_text`'s handler, lazily.

### Decision 8 — Module name: `apps/core/src/ear-sessions/`

The capability is named `tool-driven-ear-sessions` in OpenSpec but the directory uses the shorter `ear-sessions/` form for ergonomics. This mirrors the existing pattern (`session-watcher/` → `SessionWatcherService`, `notes/` → `NotesAgentService`).

## Risks / Trade-offs

- **Risk: Concurrency between supervisor turn invoking `begin_dictation` and the next session opening.** Mitigation: the router's `arm` registers a reservation keyed by `deviceId`; the next `session_start` from that device matches the reservation by mode. If a second `session_start` arrives before the matching one (race), the second is treated as an un-owned regular session and the reservation stays open until it times out (10 s) or the next matching session arrives.
- **Risk: Session-bound tool called from supervisor.** A supervisor that hallucinates a call to `append_text` would otherwise crash or no-op. Mitigation: `ToolUsedOutsideSessionError` is thrown synchronously and surfaced to the LLM as a tool-call error so the supervisor learns it cannot call that tool from outside a session loop.
- **Risk: Sub-agent infinite-loops calling `append_text`.** Mitigation: the owner safety cap (90 s) is the backstop. Beyond that, we could rate-limit per-final tool calls inside the sub-agent prompt, but that is a domain concern, not a framework one.
- **Trade-off: First-final intent latency.** Adds up to ~one supervisor turn of latency to opening a dictation session. Acceptable for the MVP; revisit if user-visible.
- **Trade-off: `SessionWatcher` removal is destructive.** No fallback path. We accept this because the new pattern fully subsumes the old one and the long-note-mode shipping commit is recent (one commit on `main`).

## Migration Plan

1. Land `tool-driven-ear-sessions` capability code (`apps/core/src/ear-sessions/`).
2. Add `begin_dictation`, `append_text`, `finalize_note`, `discard_note` to the notes domain.
3. Wire the session pipeline's final/end fanout to consult `EarSessionRouter`.
4. Delete `apps/core/src/session-watcher/` and references.
5. Delete `enable_long_note_mode` / `end_long_note_mode` tools and references.
6. Update the AgentSpec smoke test to exercise session-bound context narrowing.
7. Manual verification: trigger dictation flow end-to-end (short utterance → tap → supervisor → `begin_dictation` → fresh long session → append on each final → tap to end → file in `output/notes/`).

No external migration needed (single user, single machine, no persisted state beyond `output/notes/` which is forward-compatible).

## Open Questions

- Does `begin_dictation` need a `prompt: string` argument so the supervisor can pass context ("the user said: запиши большую заметку")? Initial answer: no — the supervisor's routing already implies intent, and the sub-agent's first turn is `initialPrompt` from the runner. Revisit if the sub-agent makes bad early calls without context.
- Should the runner pass partials to the sub-agent (e.g. as silent context updates)? Initial answer: no — partials are noisy and the sub-agent only needs to decide on finals. Revisit if stop-decision quality suffers.
- Should the notes sub-agent use `Haiku` specifically, or take a model from `AgentSpec.model`? Initial answer: take it from `AgentSpec.model` so we can swap. The notes module sets it to Haiku in its module file.
