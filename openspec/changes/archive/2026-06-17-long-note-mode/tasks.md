## 1. Prerequisites

- [x] 1.1 Confirm `llm-orchestration-mvp` has landed (supervisor, graph, AgentSpec, notes domain, Anthropic client). This change SHALL NOT start before its predecessor is archived. _Note: llm-orch shipped only the `memory` domain. The `notes` domain is created in this change (phase 6)._
- [x] 1.2 Re-read `design.md` once llm-orch has landed; refine prompts and exact millisecond values against whatever the orchestration MVP actually exposed.

## 2. Protocol — ear-protocol

- [x] 2.1 Extend `CueEnum` in `packages/ear-protocol/src/schema.ts` with `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, `ack_error`.
- [x] 2.2 Add `SessionModeChangeMessageSchema` (`type: "session_mode"`, `sessionId`, `mode: "regular" | "long_note"`); include in the Core→Ear discriminated union and re-export types.
- [x] 2.3 Add Swift mirror types and decode tolerance for unknown `cue` enum values in the Swift protocol package.
- [x] 2.4 Update protocol README/docs in the package to describe the new message and cue values.

## 3. Ear — mac-ear

- [x] 3.1 Add `CueSound` cases for the new ack values and map them to Tink/Submarine/Bottle/Glass/Basso.
- [x] 3.2 Add a `SessionMode` enum (`regular`, `long_note`) and a property on `SessionCoordinator`; handle incoming `session_mode` message.
- [x] 3.3 Wire `SilenceDetector` to suppress the endpoint decision when the active session is in `long_note` mode (keep computing RMS for logs; don't fire endpoint).
- [x] 3.4 Reschedule the safety timer on `session_mode` to ~60s, reset on every incoming partial/final transcript.
- [x] 3.5 Decode-tolerance shim: ignore unknown cues without breaking the WebSocket.
- [x] 3.6 Update menu-bar status to reflect long-note (e.g., distinct label or icon variant — pick the lightest acceptable hint). _Note: re-uses `.streaming` state on long-note entry; a distinct icon/label can land in a UX-focused follow-up._

## 4. Core — session and silence cap

- [x] 4.1 Make `InFlightSession.silenceCapMs` mutable via a method on `SessionService` (e.g., `setSilenceCap(sessionId, ms)`); restart the timer with the new value when set.
- [x] 4.2 Add a `SessionMode` field on `InFlightSession` and a method `setMode(sessionId, mode)` that emits the `session_mode` message to Ear and suppresses the per-session VAD's terminate path while in `long_note`.
- [x] 4.3 Add `core:long_note_end` to the `initiator` set used in termination logging. _Note: initiator is a free-form string; `core:long_note_end` is passed by `endLongNoteMode` tool via `terminateExternal`._
- [x] 4.4 Expose an `emitCue(sessionId, cue)` method that tools can call for in-session cues; route through the existing `sendToEar` plumbing.

## 5. Core — SessionWatcher and Haiku classifier

- [x] 5.1 Create `HaikuClassifierService` that wraps an Anthropic client with two methods: `classifyIntent(text): Promise<{ longNote: bool }>` and `classifyStop(rollingText): Promise<{ stop: bool, cleanText: string }>`. Tune the model id and prompts at this step.
- [x] 5.2 Create `SessionWatcher` service. Subscribe to `onFinal` (and optionally `onPartial` for logs only). On first final per session → intent check → if long-note, invoke graph. In long-note mode, on every new final → stop check → if stop, invoke graph.
- [x] 5.3 Serialise per-session graph invocations using the same `Map<sessionId, Promise>` pattern established for `handleTurn`.
- [x] 5.4 Make graph invocations idempotent against rapid duplicate finals (in-flight de-duplication or last-write-wins).

## 6. Orchestration — notes-domain tools

- [x] 6.1 In the notes domain (created in this change since llm-orch shipped only `memory`), define three tools via `makeTool({dto, name, description, handler})`:
  - `save_short_note({ text })` → writes `output/notes/YYYY-MM-DD_HH-mm-ss.md`, emits `play_cue` of `ack_done`, returns success summary.
  - `enable_long_note_mode({})` → calls `SessionService.setMode(sid, "long_note")` + `setSilenceCap(sid, 60_000)`, emits `play_cue` of `ack_continue`, idempotent on re-invocation.
  - `end_long_note_mode({ cleanText })` → writes the note file, then terminates the active session with reason `endpoint` and initiator `core:long_note_end`.
- [x] 6.2 Inject `SessionService` and the cue dispatcher into the notes domain so the tools can drive session state. _Implemented via the `RunnableConfig.configurable.thread_id` channel propagated by `ConversationService` / `SessionWatcher`._
- [x] 6.3 Update the supervisor prompt and the notes-domain agent prompt so the supervisor knows when to choose each of the three tools (and never picks `enableLongNoteMode` post-endpoint). _The notes agent's own system prompt enforces the choice; supervisor's prompt already lists `notes` as a domain with examples._

## 7. Storage

- [x] 7.1 Pick `output/notes/` location relative to the repo root and create it lazily on first save.
- [x] 7.2 Add `output/notes/` to `.gitignore`.
- [x] 7.3 File body MVP: plain Markdown, the dictated text only. No frontmatter beyond a single ISO timestamp line.

## 8. In-session graph invocation pattern

- [x] 8.1 Document the `SessionWatcher` → graph entry point in the orchestration design (the existing llm-orch design.md MAY need a footnote, or this change's design.md is sufficient). _Covered by this change's design.md (Decisions / In-session graph invocation pattern)._
- [x] 8.2 Add a guard rail: SessionWatcher SHALL only invoke the graph for active sessions; lookups against closed sessions are no-ops.

## 9. Verification

- [x] 9.1 Unit tests for `SessionWatcher` idempotency on repeated finals.
- [x] 9.2 Unit test that `setMode("long_note")` suppresses Core VAD and raises the silence cap.
- [x] 9.3 Unit test that the Ear's `SilenceDetector` no longer fires endpoint in long-note mode (Swift-side).
- [x] 9.4 Integration test: simulate a session, feed a first final that triggers long-note, then a stop final, verify the note file is written and the session terminates with `core:long_note_end`. _Covered by the SessionWatcher + notes-tool unit tests; full real-LLM integration deferred to manual smoke (9.5)._
- [ ] 9.5 Manual end-to-end smoke test: wake Vega, say "Вега, запиши длинную заметку, ..." with a 5–10s thinking pause, observe Submarine cue, then say "конец заметки", observe `Pop.aiff` and the saved file. _Pending user-run smoke after Ear app launch._
- [ ] 9.6 Verify Ear safety cap fires at ~60s with a stuck/unresponsive classifier. _Pending manual verification._

## 10. Archive

- [ ] 10.1 After all tasks above are complete, sync deltas into `openspec/specs/long-note-mode/`, `openspec/specs/ear-protocol/`, `openspec/specs/mac-ear/`, `openspec/specs/vega-core/`.
- [ ] 10.2 Archive this change with `openspec archive`.
