## 1. Protocol schema

- [x] 1.1 Add `"ask"` to `SessionModeEnum` in `packages/ear-protocol/src/schema.ts`
- [x] 1.2 Add `"cue_listen"` to `OverlaySoundEnum`
- [x] 1.3 Add optional `captureMs` to `ArmCaptureMessage` schema
- [x] 1.4 Update round-trip tests to cover ask mode + cue_listen + captureMs

## 2. Core: EarSessionRouter — ask session lifecycle

- [x] 2.1 Add `AskSessionOutcome` type (`{kind:"answer", text} | {kind:"timeout"} | {kind:"cancelled"}`)
- [x] 2.2 Add `askHandles: Map<deviceId, Deferred<AskSessionOutcome>>` to router
- [x] 2.3 Implement `openAskSession({deviceId, captureMs}): Promise<AskSessionOutcome>` — reserve, emit `arm_capture {mode:"ask", captureMs}`, set up safety timer (captureMs + 2_000), return deferred promise
- [x] 2.4 Special-case `bindOnSessionStart` for `mode:"ask"` — track ownership as ask without ownerSpec
- [x] 2.5 Extend `ArmOptions` with `artifactName?: string` and stash into `ActiveOwnership`
- [x] 2.6 Pass `caption: artifactName` to overlay bridge in `arm()` when mode is `continuous`

## 3. Core: ask-session fanout wiring

- [x] 3.1 In `EarSessionsModule` (or session.service): when `final_transcript` arrives for an ask-session, terminate with `endpoint` + initiator `core:ask_first_final`, resolve the askHandle with `{kind:"answer", text}`
- [x] 3.2 When `session_end` from Ear arrives for an ask-session (`timeout|user|vad`), resolve askHandle with `{kind:"timeout"}` or `{kind:"cancelled"}` and use initiators `core:ear_timeout|core:ear_user|core:ear_vad`
- [x] 3.3 Set ask-session silence cap to `captureMs` and suppress per-session VAD termination
- [x] 3.4 Ensure ask-session is NOT persisted to `recordings/`
- [x] 3.5 Ensure ask-session finals do NOT enter `handleTurn`

## 4. Core: ask_user kernel tool

- [x] 4.1 Create DTO `apps/core/src/conversation/kernel/tools/ask-user.dto.ts` with `question`, `hint?`, `captureMs?` (defaults)
- [x] 4.2 Create `ask-user.tool.ts` with `buildAskUserTool(router, sessions, overlay)`
- [x] 4.3 Implement handler: resolve deviceId, set overlay listening+caption+cue_listen, `await router.openAskSession`, map outcome, reset overlay to idle
- [x] 4.4 Export builder from kernel tools index (n/a — no central index; domains import directly, same pattern as `update_overlay` / `open_continuous_session`)

## 5. Core: open_continuous_session — name param

- [x] 5.1 Add `name: string (1..120)` to `OpenContinuousSessionDto`
- [x] 5.2 Pass `artifactName: name` and `intent` into `router.arm`
- [x] 5.3 Return `{...ArmResult, artifactName}`

## 6. Core: notes domain rewrite

- [x] 6.1 Add `slug(name)` helper in notes-storage.service.ts (unit-tested)
- [x] 6.2 Add `NotesStorageService.startNamed(sessionId, name, now?)` — pre-allocate `<slug>_<ts>.md`, write header, register in `inProgress`
- [x] 6.3 Modify `appendChunk` to require existing path (no longer lazy-creates); throw or no-op if no `startNamed` call happened (kept defensive lazy fallback with warn so user dictation is never lost)
- [x] 6.4 Remove `NotesStorageService.saveNote()`
- [x] 6.5 Remove `SaveShortNoteDto` and `save_short_note` tool from `notes.tools.ts`
- [x] 6.6 In `notes.tools.ts` inject `ask_user` into supervisor tools bundle alongside `open_continuous_session` and `update_overlay`
- [x] 6.7 Update `NOTES_SUPERVISOR_SYSTEM_PROMPT` — drop short-note branch; describe name-aware decision matrix and `ask_user` fallback
- [x] 6.8 Wire notes session-bound runner to call `startNamed` when ownership becomes active (via `EarSessionRouter.ownershipOf(sessionId).artifactName`)
- [x] 6.9 Update `NOTES_SESSION_SYSTEM_PROMPT` — no behavioural change needed; just confirm finalize still overwrites in-place

## 7. mac-ear: ask mode

- [x] 7.1 Add `.ask` to Swift `SessionMode` enum mirror
- [x] 7.2 Decode `captureMs` from `arm_capture` payload
- [x] 7.3 On `arm_capture mode:"ask"`: open fresh session with `mode:"ask"`, play `cue_listen` locally, send `session_start mode:"ask"`
- [x] 7.4 Suppress local VAD endpoint inside ask-session
- [x] 7.5 Run local safety cap from `captureMs` (default 8000), on fire emit `session_end timeout`
- [x] 7.6 On user tap during ask-session emit `session_end user` (existing `stopActiveSession` already routes through `endSessionLocally(reason: .user)`)
- [x] 7.7 Map `cue_listen` to a system sound (e.g. `Tink.aiff`)

## 8. Tests

- [x] 8.1 Unit: slug() — cases: cyrillic spaces, punctuation only, length clamp
- [x] 8.2 Unit: `EarSessionRouter.openAskSession` — answer, timeout, cancel paths
- [x] 8.3 Integration: notes flow with name in utterance → continuous opens with named file (full-flow.test now passes ArmOptions with artifactName, asserts filename via storage)
- [x] 8.4 Integration: notes flow without name → ask_user invoked → continuous opens with captured name (named-flow.test stitches ask_user answer into open_continuous_session)
- [x] 8.5 Integration: ask_user timeout → no continuous session opened, error overlay set (named-flow.test verifies router.arm never called on timeout/cancel)
- [x] 8.6 Protocol round-trip: ask mode, cue_listen, captureMs (TS + Swift round-trip suites both green)

## 9. Manual verification

- [ ] 9.1 Run core + mac-ear, say "запиши длинную заметку про идею проекта" → file `идея-проекта_<ts>.md` is created in `output/notes/`
- [ ] 9.2 Say "запиши длинную заметку" → overlay shows "Как назвать заметку?", say "вторая идея" → continuous starts, file `вторая-идея_<ts>.md` created
- [ ] 9.3 Say "запиши длинную заметку" → stay silent 8 s → error overlay, no continuous, no file
- [ ] 9.4 Continuous overlay caption shows the note name during dictation

> Group 9 is live mic + Mac app verification, requires the user to run end-to-end. Code complete; verification is the next manual step.
