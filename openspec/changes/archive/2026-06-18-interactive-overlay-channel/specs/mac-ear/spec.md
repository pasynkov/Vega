## ADDED Requirements

### Requirement: Interactive overlay window

The Mac Ear SHALL render an interactive overlay window driven by `overlay_update` messages from Core. The overlay SHALL be implemented as an `NSPanel` with:

- `styleMask` containing `.borderless` and `.nonactivatingPanel`
- `level` set to `.floating`
- `backgroundColor = .clear`, `isOpaque = false`, `hasShadow = false`
- `ignoresMouseEvents = true` at all times (the overlay is purely informational; cancelling a session is done by going silent, not by clicking)
- `collectionBehavior` allowing it to appear on every Space and stay above fullscreen apps

The overlay SHALL anchor under the menu-bar status item: its top-right corner sits ≈6 pt below the status icon's bottom-right corner (clamped to the screen), so it reads as a dropdown from the tray icon. When the status-item frame is not available yet, the overlay SHALL fall back to the top-right corner of the screen containing the menu-bar item. Its content SHALL be a SwiftUI view composed of:

- An orb visual (SwiftUI `Canvas` or shape with state-driven gradient + pulse animation) sized ~96 pt.
- An optional top text section showing `state.hint` (collapses if absent).
- An optional bottom text section showing `state.caption` (collapses if absent).
- A rounded-rect background using `.ultraThinMaterial` with `cornerRadius: 22`.
- Fade-in/scale-up appearance and fade-out/scale-down disappearance, animated over ~200 ms.

The overlay SHALL be visible whenever the current `state.kind` is not `idle`. On `idle` it SHALL hide. The Ear SHALL NOT hide the overlay in response to `session_end` (Core- or Ear-initiated); the overlay is intentionally decoupled from session lifecycle so the user keeps seeing a `thinking` state while the orchestrator dispatches between sessions. The overlay SHALL hide only on (a) receipt of an `overlay_update` with `state.kind == idle`, (b) WebSocket disconnect from Core, (c) user-initiated pause or app shutdown.

#### Scenario: Overlay appears on first non-idle update

- **WHEN** the Ear receives `{ type: "overlay_update", seq: 1, state: { kind: "listening" } }` and the overlay is currently hidden
- **THEN** the overlay window SHALL fade in within ~200 ms with the listening orb visual
- **AND** no top or bottom text section SHALL be rendered

#### Scenario: Overlay shows hint and caption together

- **WHEN** the Ear receives `{ type: "overlay_update", seq: 7, state: { kind: "processing", hint: "Сохраняю заметку…", caption: "купи молоко" } }`
- **THEN** the overlay SHALL render the processing orb, the hint above, and the caption below

#### Scenario: Overlay survives session_end (bridge state during dispatch)

- **WHEN** the Ear has a visible overlay (e.g. `thinking`) and receives `{ type: "session_end", sessionId: <S>, reason: "endpoint" }` for the active session
- **THEN** the overlay SHALL stay visible with its current state
- **AND** the next `overlay_update` Core emits (e.g. `arm_capture` follow-up `listening`, domain `success`, or implicit `idle`) SHALL drive the transition

#### Scenario: Overlay collapses on idle update

- **WHEN** the Ear receives `{ type: "overlay_update", seq: N, state: { kind: "idle" } }`
- **THEN** the overlay SHALL fade out and hide
- **AND** the next visible overlay SHALL require a new non-idle update from Core

### Requirement: Overlay state model parser tolerates unknown values

The Ear SHALL decode `overlay_update.state.kind` and `overlay_update.state.sound` via Codable. Unknown enum values SHALL be surfaced as `.unknown` without aborting the WebSocket connection. An `overlay_update` whose `kind` is `.unknown` SHALL render the default `listening`-style orb with whatever text fields decoded successfully, and SHALL be logged at debug level so the schema gap is visible offline.

#### Scenario: Unknown kind falls back to listening visual

- **WHEN** the Ear receives `{ type: "overlay_update", seq: 3, state: { kind: "wat", hint: "x" } }`
- **THEN** the overlay SHALL render the listening-style orb with hint `"x"`
- **AND** the WebSocket SHALL stay open
- **AND** the app log SHALL include a debug entry naming the unknown kind

## MODIFIED Requirements

### Requirement: Audible feedback cues

The Ear SHALL play a system sound on wake-word detection ("wake cue") locally — without waiting on any Core message. The Ear SHALL play a different system sound when entering `continuous` capture via `arm_capture` (`ack_continue` / Submarine) locally, also without waiting on a separate cue message. Every other audible cue SHALL be driven by the `state.sound` field of `overlay_update` messages: when present, the Ear SHALL play the named cue exactly once at the moment the update is rendered.

The MVP cue assets remain: `wake` → `Purr.aiff`; `endpoint` → `/System/Library/Sounds/Pop.aiff`; `error` → `/System/Library/Sounds/Basso.aiff`; the `ack_*` family uses the existing macOS system sounds. The choice is a one-line constant per cue and may evolve without re-spec.

The Ear SHALL NOT handle a `play_cue` message; that message type has been removed from the protocol.

#### Scenario: Successful capture cycle

- **WHEN** the user says "Vega, write down to buy milk"
- **THEN** the wake cue SHALL play once at wake-word detection (local)
- **AND** an `overlay_update` carrying `state.sound: "ack_done"` (or `"endpoint"` on a non-domain-handled flow) SHALL play exactly once when received
- **AND** no other cue SHALL play during the cycle

#### Scenario: Session ends with error

- **WHEN** Core closes the session with a `session_end` reason other than `vad` or `endpoint`, or the WebSocket disconnects mid-session
- **THEN** the error cue SHALL play if Core supplied it via an `overlay_update` before the disconnect (`state.sound: "error"`), or the Ear's local disconnect handler SHALL play `error` locally
- **AND** the status item SHALL transition back to `idle` (or `error` if the disconnect persists)
- **AND** the overlay SHALL hide
