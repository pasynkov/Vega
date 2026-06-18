## 1. Protocol rename (ear-protocol + Swift)

- [ ] 1.1 In `packages/ear-protocol/src/schema.ts`, rename the zod `SessionModeEnum` value `long_note` → `continuous`; verify every message schema (`SessionStart`, `SessionMode`, `ArmCapture`, etc.) still type-checks with the new enum literal
- [ ] 1.2 Rebuild `packages/ear-protocol/dist/` (run the package's existing build script); commit the regenerated `dist/schema.{js,d.ts}` so consumers don't drift
- [ ] 1.3 Bump `packages/ear-protocol/package.json` minor → next major to flag the wire break
- [ ] 1.4 In `packages/ear-protocol/swift/Sources/EarProtocol/EarProtocol.swift`, rename `SessionMode.longNote` → `SessionMode.continuous` with raw value `"continuous"`; verify `swift build` for the package
- [ ] 1.5 Update `packages/ear-protocol/README.md`: replace every `long_note` mention with `continuous` and add a one-line note that this is a breaking rename from the previous value

## 2. Mac-ear (Swift consumer)

- [ ] 2.1 Grep `apps/mac-ear/Sources/` for `longNote` and `long_note`; rewrite each call site to use `SessionMode.continuous` / `"continuous"`
- [ ] 2.2 Update UI strings that reference the old name (menu items, status labels) — the user-facing English label can stay "Long note" if the developer prefers, but the underlying mode value SHALL be `continuous`
- [ ] 2.3 Run `swift build` in `apps/mac-ear/` and confirm zero warnings / errors related to the rename
- [ ] 2.4 Smoke-launch the Mac app against Core once during step 4 verification (no separate boot step in this task group)

## 3. Core + kernel builder

- [ ] 3.1 Create `apps/core/src/conversation/kernel/tools/` directory (new) and add `open-continuous-session.tool.ts` exporting `buildOpenContinuousSessionTool(router, ownerSpecRef)` per the design
- [ ] 3.2 Add or move `OpenContinuousSessionDto` (renamed from `BeginDictationDto`) into `apps/core/src/conversation/kernel/tools/open-continuous-session.dto.ts` so the DTO lives next to the tool
- [ ] 3.3 In `apps/core/src/conversation/ear/session/session.service.ts`, rename `LONG_NOTE_SILENCE_CAP_MS` → `CONTINUOUS_MODE_SILENCE_CAP_MS` and every `mode === "long_note"` comparison → `mode === "continuous"`
- [ ] 3.4 In `apps/core/src/conversation/sessions/ear-session-router.service.ts` and `session-agent-runner.service.ts`, update mode-value comparisons / log fields from `long_note` → `continuous` (no type changes — the protocol enum now has the new value)
- [ ] 3.5 In `apps/core/src/domains/notes/notes.tools.ts`, drop the inline `begin_dictation` factory and instead push `buildOpenContinuousSessionTool(router, sessionSpecRef)` into the `supervisorTools` array; remove the now-unused `BeginDictationDto` import; delete the old DTO file
- [ ] 3.6 In `apps/core/src/domains/notes/notes.agent.ts`, replace every `begin_dictation` / `long_note` occurrence in the supervisor-side and session-bound system prompts with `open_continuous_session` / `continuous` (preserve Russian-language UX phrasing where it describes the user-perceived "длинная заметка")
- [ ] 3.7 Run `npx tsc --noEmit` from `apps/core/` and confirm zero errors

## 4. Tests + verification

- [ ] 4.1 Update every test file under `apps/core/tests/` that constructs a `session_start` / `arm_capture` message with `mode: "long_note"` to use `mode: "continuous"` (vitest grep for `long_note` should return zero hits afterward)
- [ ] 4.2 Update `apps/core/tests/ear-sessions/full-flow.test.ts` mock recognizer regexes: the mocked supervisor / sub-agent string match on `begin_dictation` / `long_note` → `open_continuous_session` / `continuous`
- [ ] 4.3 Run `npm --workspace apps/core test`; confirm the full suite is green
- [ ] 4.4 Run `npm run core:dev` for ~15 seconds against the real Mac ear; speak the user's existing long-note trigger phrase and confirm Core dispatches `arm_capture { mode: "continuous" }` (visible in the log) and the new continuous session bound to `notes-session` opens cleanly
- [ ] 4.5 Final grep across `apps/`, `packages/`, and `openspec/` (excluding `openspec/changes/archive/`) for `long_note` — only documentation / spec-folder paths should remain; flag any stray code occurrences and fix
- [ ] 4.6 Commit each task group as its own commit (`refactor(ear-protocol)`, `refactor(mac-ear)`, `refactor(core)`, `test(core)`) and update tasks.md as each lands
