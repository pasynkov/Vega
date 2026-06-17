## 1. Scaffold capability module

- [x] 1.1 Create `apps/core/src/ear-sessions/` with NestJS module file `ear-sessions.module.ts`
- [x] 1.2 Add `EAR_SESSION_OWNER_CAP_MS` to typed config (`@balancy/config`) with default `90000`
- [x] 1.3 Define `EarSessionHandle` type (`apps/core/src/ear-sessions/ear-session-handle.ts`) exposing `sessionId`, `deviceId`, `mode`, `arrivedAt`, plus helpers the runner injects into tool ctx
- [x] 1.4 Define `ToolUsedOutsideSessionError` and `EarSessionReservationConflictError` exception classes
- [x] 1.5 Register the module in `app.module.ts`; export `EarSessionRouter` and the runner

## 2. EarSessionRouter

- [x] 2.1 Implement `EarSessionRouter.arm({ ownerSpec, mode, deviceId? })` that resolves the target Ear and sends `arm_capture`
- [x] 2.2 Track reservations keyed by `deviceId` with a 10s expiry; reject double-arm with `EarSessionReservationConflictError`
- [x] 2.3 Implement `bindOnSessionStart(sessionStart)` that promotes a matching reservation into an active ownership entry keyed by `sessionId`
- [x] 2.4 Implement `ownerOf(sessionId): AgentSpec | undefined` and `release(sessionId)`
- [x] 2.5 Unit-test reservation expiry, double-arm rejection, and binding on matching `session_start`

## 3. Session runner

- [x] 3.1 Implement `SessionAgentRunner.start({ handle, spec, initialPrompt })` returning a controller object with `pushFinal(text)`, `signalEnd(reason)`, `forceTimeout()`
- [x] 3.2 Maintain a per-session FIFO queue of finals; serialise sub-agent turns; preserve order
- [x] 3.3 Boot the sub-agent using existing `sub-agent.factory.ts` infra; pass `spec.systemPrompt`, `spec.tools`, `spec.model`; inject `EarSessionHandle` on tool ctx
- [x] 3.4 Interpret tool return values: any `{ release: true, reason }` ends the loop and triggers ownership release
- [x] 3.5 Start the owner safety cap timer on session_start; on fire, run the domain's flush hook (if registered), then force-release with reason `timeout`
- [x] 3.6 On unhandled sub-agent error: log, run flush hook, release with reason `stt_error`, initiator `core:tool_error`
- [x] 3.7 On `signalEnd("user")` (Ear-side tap during owned session): drain queued finals, deliver a synthetic "user has ended capture; finalize or discard" terminal turn, release after the next tool result

## 4. Wire router into the session pipeline

- [x] 4.1 In `apps/core/src/session/` (or wherever the final/end fanout lives), inject `EarSessionRouter` and the runner
- [x] 4.2 On `session_start`, call `router.bindOnSessionStart`. If it returns an owner, instantiate `SessionAgentRunner.start(...)` and stash the controller on the session.
- [x] 4.3 On every `final_transcript`, if the session has a controller, route the final to `controller.pushFinal(text)` instead of accumulating for `handleTurn`
- [x] 4.4 On Ear-initiated `session_end` for an owned session, call `controller.signalEnd(reason)`; do not run the existing `handleTurn` path for that session
- [x] 4.5 On final `session_end` of an owned session (any side), release router ownership

## 5. Notes domain: session-bound tools

- [x] 5.1 Add `begin_dictation` to `notes.tools.ts`. Handler: call `EarSessionRouter.arm({ ownerSpec: notesAgentSpec, mode: "long_note" })`; return arm result.
- [x] 5.2 Add `append_text(text)` (session-bound). Handler reads `ctx.earSession` (throw `ToolUsedOutsideSessionError` if absent), lazy-opens `output/notes/<ts>.md` on first call, appends `text + "\n"`.
- [x] 5.3 Add `finalize_note(cleanText)` (session-bound). Overwrite the in-progress file with `cleanText`; return `{ release: true, reason: "endpoint" }`.
- [x] 5.4 Add `discard_note(reason)` (session-bound). Delete in-progress file; return `{ release: true, reason: "user" }`.
- [x] 5.5 Register a flush hook with the runner that, on cap or error, leaves the in-progress file as-is (already saved incrementally).
- [x] 5.6 Update `notes.agent.ts` (notes sub-agent `AgentSpec`): set `systemPrompt` to drive a Haiku-style per-final stop check from inside the loop; set `model` to the cheap-LLM identifier; expose only `append_text`, `finalize_note`, `discard_note`.
- [x] 5.7 Update the supervisor-visible notes spec: expose `save_short_note` (existing) + `begin_dictation` (new); remove `enable_long_note_mode`, `end_long_note_mode`.

## 6. Remove old plumbing

- [x] 6.1 Delete `apps/core/src/session-watcher/` (service, classifier, module)
- [x] 6.2 Remove imports/registrations from `app.module.ts`
- [x] 6.3 Remove `enable_long_note_mode`, `end_long_note_mode` tools + their DTOs from notes
- [x] 6.4 Remove `core:long_note_end` initiator label; replace usages with `core:tool_release`
- [x] 6.5 Verify no dead imports remain (`pnpm -C apps/core typecheck`)

## 7. Tests and verification

- [x] 7.1 Unit-test `EarSessionRouter`: arm, bind, double-arm, expiry
- [x] 7.2 Unit-test `SessionAgentRunner`: queue ordering, release detection, safety cap fires flush, error path
- [x] 7.3 Integration test: stub Ear, drive `arm_capture` → `session_start` → three finals → `finalize_note`, assert file content + `session_end` reason `endpoint` + initiator `core:tool_release`
- [x] 7.4 Integration test: same flow but no `finalize_note` ever called, assert `core:owner_safety_cap` fires at the configured cap
- [x] 7.5 Boot-time smoke test: confirm session-bound tools throw `ToolUsedOutsideSessionError` when ctx lacks `earSession` (one negative-path test per tool)
- [x] 7.6 Manual verification on real Mac Ear: short utterance "запиши большую заметку" → tap → submarine cue → speak two paragraphs with a 5-second pause between → final tap → file in `output/notes/` contains both paragraphs

## 8. Specs and docs

- [x] 8.1 Run `openspec validate tool-driven-ear-sessions --strict`
- [x] 8.2 After merge, `openspec archive tool-driven-ear-sessions`
- [x] 8.3 Update `apps/core/README.md` (if present) to document the session-ownership flow and the `EAR_SESSION_OWNER_CAP_MS` env var
