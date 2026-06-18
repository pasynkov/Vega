## 1. ear-protocol package

- [x] 1.1 Add `OverlayKindEnum`, `OverlaySoundEnum` (Zod), and `OverlayStateSchema` in `packages/ear-protocol/src/schema.ts` with the bounds defined in specs (hint ≤ 120, caption ≤ 240, sound excludes `wake`)
- [x] 1.2 Add `OverlayUpdateMessageSchema` (`type`, `seq` positive int, `state: OverlayStateSchema`); export type
- [x] 1.3 Add `OverlayUpdateMessageSchema` to `CoreToEarMessageSchema` discriminated union
- [x] 1.4 Remove `PlayCueMessageSchema` and its type export from the schema and from `CoreToEarMessageSchema`
- [x] 1.5 Update Swift mirror in `packages/ear-protocol/swift/` to match: add `OverlayUpdateMessage`, `OverlayState`, `OverlayKind`, `OverlaySound` Codable types with `.unknown` fallbacks; remove `PlayCueMessage`
- [x] 1.6 Update round-trip example payloads + tests to cover `overlay_update` (every `kind`; sound rejected when `wake`); remove `play_cue` examples
- [x] 1.7 Run `packages/ear-protocol` test suite — green

## 2. Core: OverlayService

- [x] 2.1 Create `apps/core/src/conversation/overlay/overlay.service.ts` with per-device state map, monotonic `seq` per connection, `set(deviceId, state)` API, optional ttl handling, single-writer queue (serialise within a device)
- [x] 2.2 Wire OverlayService send through the existing Ear gateway so messages emit on the device's WebSocket; reset device's seq counter on register
- [x] 2.3 Create `OverlayModule` exporting `OverlayService`; import from `ConversationModule` (or wherever Ear gateway lives)
- [x] 2.4 Implement ttl: schedule `setTimeout` → call into `EarSessionRouter` / `SessionService` to end the active session with reason `endpoint`; cancel on next `set`; clean up on register/disconnect
- [x] 2.5 Validate inputs at the service boundary (delegate to Zod schema from ear-protocol)
- [x] 2.6 Unit tests: monotonic seq, ttl cancellation on overwrite, validation rejects oversize text, no-op when device unknown, reconnect resets seq

## 3. Core: implicit overlay triggers

- [x] 3.1 In wake flow (where `wake_ack` of action `proceed` is emitted), call `OverlayService.set(deviceId, {kind: "listening"})`
- [x] 3.2 In `SessionService.partial_transcript` emit path, call `OverlayService.set(deviceId, {kind: "capturing", caption: partial.text})`
- [x] 3.3 In `SessionService.final_transcript` emit path, call `OverlayService.set(deviceId, {kind: "thinking", caption: final.text})`
- [x] 3.4 In session-end paths (Core- and Ear-initiated), cancel any ttl timer for the device but do NOT emit `overlay_update` (client drops overlay on session_end)
- [x] 3.5 Remove every existing `play_cue` emit site in Core; replace with `OverlayService.set` carrying the corresponding `sound` plus an appropriate `kind`
- [x] 3.6 Integration test: one short turn → wake_ack→listening, partial→capturing, final→thinking, session_end → no overlay_update; verify seq monotonic across the sequence

## 4. Core: kernel `update_overlay` tool

- [x] 4.1 Create `apps/core/src/conversation/kernel/tools/update-overlay.tool.ts` with DTO (Zod) for `{kind, hint?, caption?, sound?, ttl?}` and `buildUpdateOverlayTool(overlay: OverlayService): AgentTool`
- [x] 4.2 Handler resolves `deviceId` from `ctx` (the session/Ear binding), calls `overlay.set(deviceId, state)`, returns `{ ok: true }`; no-op gracefully when no active session
- [x] 4.3 Unit tests: handler emits via OverlayService once per call; ttl is forwarded; no-active-session returns `{ ok: true }` without throwing

## 5. notes domain wiring (validation surface)

- [x] 5.1 Inject `OverlayService` into `NotesAgentService` and add `buildUpdateOverlayTool(overlay)` to the supervisor-side tool bundle in `apps/core/src/domains/notes/notes.tools.ts`
- [x] 5.2 Update notes agent prompts to instruct the model to paint `processing` when starting work and `success`/`error` (with `ttl: 1500`/`2500` and matching `sound`) on completion
- [x] 5.3 Adjust `save_short_note`: prefer overlay-driven feedback; if the existing `emitCue("ack_done")` path remains, route it via OverlayService (or remove if redundant with explicit overlay updates from the model)
- [x] 5.4 Continuous-mode notes flow: verify implicit `thinking + caption` per final renders correctly and the closing tool (`finalize_note` / `discard_note`) emits a `success`/`idle` overlay update with `ttl` so the session terminates cleanly
- [x] 5.5 Manual end-to-end test on macOS: short save → listening → capturing → thinking → processing → success → fade; continuous dictate → multiple thinking+caption updates → finalize → success → fade

## 6. mac-ear: overlay window

- [x] 6.1 Add `OverlayWindowController.swift` creating the NSPanel (borderless, nonactivating, floating, clear bg, no shadow, ignoresMouseEvents, multi-space collectionBehavior); position bottom-center of the screen with the menu-bar item
- [x] 6.2 Add `OverlayViewModel.swift` (ObservableObject) with `kind`, `hint`, `caption`, `visible`, last-applied `seq`; ignore stale messages (`seq <= lastSeq`)
- [x] 6.3 Add `OverlayView.swift` (SwiftUI) — orb (Circle + RadialGradient + pulse animation keyed off `kind`), top text section (hides if `hint == nil`), bottom text section (hides if `caption == nil`), `.ultraThinMaterial` background with `cornerRadius: 22`, fade+scale appearance/disappearance ~200 ms
- [x] 6.4 Wire `EarSocket` decoder to handle `overlay_update`: update view-model, play `state.sound` via CuePlayer if present; tolerate unknown `kind`/`sound` as `.unknown` with default visual and debug log
- [x] 6.5 Remove `play_cue` handler branch in `SessionCoordinator`; keep CuePlayer wiring for `wake` (wake-word) and `ack_continue` (on `arm_capture`)
- [x] 6.6 Hook session lifecycle: any `session_end` (Core or local) sets view-model `visible = false`, clears state, resets `lastSeq`
- [x] 6.7 Mount the overlay controller from `AppDelegate` alongside `StatusItemController`
- [x] 6.8 Manual smoke: trigger overlay updates from the simulator/dev tools and observe the panel paints, pulses, and fades correctly

## 7. Cross-cutting cleanup

- [x] 7.1 Grep the repo for any remaining `play_cue` references (Core, Swift, tests, docs); remove or replace
- [x] 7.2 Update any developer notes / READMEs that referenced the `play_cue` channel
- [x] 7.3 Run `apps/core` test suite and `apps/mac-ear` build — both green
- [x] 7.4 `openspec validate interactive-overlay-channel --strict` — passes
