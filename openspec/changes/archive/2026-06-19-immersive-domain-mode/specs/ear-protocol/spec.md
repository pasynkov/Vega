## ADDED Requirements

### Requirement: Immersive session-mode wire variant

The `session_start.mode` enum SHALL accept `immersive` in addition to `regular` and `continuous`. The `arm_capture.mode` enum SHALL also accept `immersive`. The `session_mode.mode` enum SHALL accept `immersive` (forward-compat hint for an active session). The Swift decoder SHALL surface unknown mode values as `.unknown` rather than disconnecting (already the rule); the new `immersive` value SHALL decode as a first-class variant on both TypeScript and Swift sides.

#### Scenario: session_start validates immersive mode

- **WHEN** the validator is given `session_start` with `mode: "immersive"`
- **THEN** validation SHALL succeed on both TypeScript and Swift sides

#### Scenario: arm_capture dispatches immersive mode

- **WHEN** the Ear receives `{ "type": "arm_capture", "mode": "immersive" }`
- **THEN** the Ear SHALL open a new capture session under `immersive` mode without waiting for a wake-word
- **AND** the Ear SHALL play the `ack_continue` cue (same as continuous — the same "immersive open" auditory signal)
- **AND** the Ear SHALL send `session_start` carrying `mode: "immersive"`

#### Scenario: round-trip fixture for immersive

- **WHEN** the package's round-trip test suite runs
- **THEN** at least one fixture per `session_start`, `arm_capture`, and `session_mode` event SHALL carry `mode: "immersive"`
- **AND** that fixture SHALL parse identically through TypeScript and Swift representations

### Requirement: Immersive overlay kind

The `overlay_update.state.kind` enum SHALL accept `immersive` in addition to `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`, `view`. `immersive` SHALL render an Ear-side UI variant that visually combines the static `view` surface (live list / caption) with a "live listening" indicator (waveform / pulsing border). The state record may carry `caption` and `hint` like other kinds.

#### Scenario: overlay_update accepts immersive kind

- **WHEN** the validator is given an `overlay_update` whose `state.kind` is `immersive`
- **THEN** validation SHALL succeed
- **AND** Swift decoding SHALL succeed and surface the kind as `.immersive`

#### Scenario: round-trip fixture for immersive overlay kind

- **WHEN** the package's round-trip test suite runs
- **THEN** at least one `overlay_update` fixture SHALL carry `state.kind: "immersive"`
