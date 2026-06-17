## MODIFIED Requirements

### Requirement: Audible feedback cues

The Ear SHALL play a system sound on wake-word detection ("wake cue") and a different system sound on end-of-utterance ("endpoint cue"). The Ear SHALL additionally play system sounds for Core-initiated acknowledgement cues used by the long-note flow and future tool-result flows.

The wake cue SHALL be a short, distinct system sound (the MVP ships `Purr.aiff`, chosen after Tink/Glass/Bottle were rejected by the developer as too sharp). The endpoint cue SHALL be `/System/Library/Sounds/Pop.aiff`. A third "error cue" using `/System/Library/Sounds/Basso.aiff` SHALL be played when a session ends with a non-success reason.

In addition, the Ear SHALL map newly defined `play_cue` values to system sounds as follows:

- `ack_done` → `/System/Library/Sounds/Tink.aiff`
- `ack_continue` → `/System/Library/Sounds/Submarine.aiff`
- `ack_thinking` → `/System/Library/Sounds/Bottle.aiff` (handler optional in MVP; play if received)
- `ack_success` → `/System/Library/Sounds/Glass.aiff` (handler optional in MVP; play if received)
- `ack_error` → `/System/Library/Sounds/Basso.aiff` (handler optional in MVP; play if received)

Sounds are loaded from `/System/Library/Sounds/`; the choices are one-line constants and may evolve without re-spec. Unknown `cue` values SHALL be ignored (per the ear-protocol forward-compatibility requirement).

#### Scenario: Successful capture cycle

- **WHEN** the user says "Vega, write down to buy milk"
- **THEN** the wake cue SHALL play once at wake-word detection
- **AND** the endpoint cue SHALL play once when the local VAD endpoints or Core signals `play_cue` of `endpoint`
- **AND** no other cue SHALL play during the cycle

#### Scenario: Session ends with error

- **WHEN** Core closes the session with a `session_end` reason other than `vad` or `endpoint`, or the WebSocket disconnects mid-session
- **THEN** the error cue SHALL play once
- **AND** the status item SHALL transition back to `idle` (or `error` if the disconnect persists)

#### Scenario: Long-note mode acknowledgement cue

- **WHEN** Core sends `play_cue` of `ack_continue` followed by `session_mode` of `long_note`
- **THEN** the Ear SHALL play `Submarine.aiff` once
- **AND** SHALL switch to long-note mode behaviour (see "Local silence-based endpoint")

#### Scenario: Short-note acknowledgement cue

- **WHEN** Core sends `play_cue` of `ack_done` at session end
- **THEN** the Ear SHALL play `Tink.aiff` once

### Requirement: Local silence-based endpoint

The Ear SHALL run a streaming RMS-based silence detector on the captured PCM and SHALL terminate a session locally when sustained silence follows observed speech. The detector SHALL self-calibrate per session: the first ~600 ms of capture SHALL be treated as ambient and the 75th-percentile RMS over that window SHALL become the session's noise floor. Speech SHALL be declared when RMS rises sufficiently above the floor; sustained silence (RMS sitting near the floor for ~3 seconds after speech was observed) SHALL fire the endpoint while the session is in `regular` mode.

When Core sends `session_mode` of `long_note` for the active session, the Ear SHALL disable the local silence-endpoint behaviour for that session. The streaming detector MAY continue running for logging or analytics, but it SHALL NOT cause the session to terminate. The session SHALL only end on (a) explicit `session_end` from Core, (b) explicit user action (menu-bar stop, pause), or (c) the Ear's safety cap.

On endpoint (in `regular` mode) the Ear SHALL play the endpoint cue locally, send `session_end` with reason `vad`, and return its menu-bar state to `idle` without waiting for Core's echo. This SHALL be the primary end-of-session signal in normal use; Core's own VAD and the safety timer are fallbacks.

#### Scenario: Adaptive endpoint fires after a phrase in regular mode

- **WHEN** the user speaks a complete phrase and then stops while the session is in `regular` mode
- **THEN** the Ear SHALL log the calibration result, the moment speech was detected, the moment silence started, and the endpoint
- **AND** SHALL emit `session_end` with reason `vad` within ~3 seconds of the user falling silent
- **AND** SHALL play the endpoint cue without waiting on Core

#### Scenario: Endpoint suppressed in long-note mode

- **WHEN** the Ear has received `session_mode` of `long_note` for the active session
- **THEN** the Ear SHALL NOT fire `session_end` with reason `vad` on any subsequent silence
- **AND** the session SHALL continue until Core, the user, or the safety cap terminates it

### Requirement: Audio capture

After a `wake_detected` event the Ear SHALL begin capturing mono PCM (signed 16-bit little-endian) from the user's chosen input device at that device's native sample rate. Captured audio SHALL be streamed unencoded to Core as `audio_frame` binary messages with the protocol's session header; the `session_start` message SHALL declare `codec: "linear16"` and report the actual `sampleRate` so Core configures Deepgram and ffmpeg accordingly. Encoding the persisted artifact to OGG/OPUS is Core's responsibility, not the Ear's.

The Ear SHALL expose a "Microphone" submenu in the menu-bar item that lists every audio input device discovered via CoreAudio plus a "System default" entry. Picking a device SHALL retarget capture without changing the macOS system-wide default. The chosen device SHALL be persisted in `Application Support/Vega/preferences.json` and restored on next launch.

A pre-roll buffer SHALL retain approximately the last one second of audio (sized in bytes relative to the live sample rate, so a Bluetooth-HFP capture at 16 kHz holds the same wall-clock duration as a 48 kHz built-in capture) and SHALL be prepended to the session when a wake event fires.

The Ear SHALL NOT itself perform speech-to-text.

The Ear's hard safety cap on capture length SHALL be 30 seconds in `regular` mode and SHALL be raised to ~60 seconds upon receiving `session_mode` of `long_note`. The safety cap timer SHALL be reset to the new duration from the moment the mode change is processed, not extended absolutely from session start. The new safety cap SHALL be measured from the last partial OR final transcript event observed by the Ear, so continued dictation keeps the timer alive.

#### Scenario: Wake triggers capture

- **WHEN** a `wake_detected` event is emitted and the WebSocket to Core is open
- **THEN** within 200 ms the Ear SHALL send a `session_start` message with a freshly generated `sessionId`
- **AND** audio capture SHALL begin from the same buffer that fed the wake-word detector, including the pre-roll preceding the detection

#### Scenario: Audio frames are sent while user speaks

- **WHEN** capture is active
- **THEN** the Ear SHALL emit `audio_frame` binary messages with `linear16` PCM payloads at a steady cadence of at least 10 frames per second
- **AND** each frame SHALL include the active `sessionId` via the protocol's binary header

#### Scenario: Hard safety cap on capture length in regular mode

- **WHEN** capture has been active for 30 seconds without a `session_end` from Core and the session is in `regular` mode
- **THEN** the Ear SHALL send `session_end` with reason `timeout`
- **AND** SHALL stop sending audio frames
- **AND** SHALL play the endpoint cue

#### Scenario: Safety cap extended after long-note mode change

- **WHEN** the Ear receives `session_mode` of `long_note` for the active session
- **THEN** the safety timer SHALL be rescheduled to ~60 seconds measured from the moment the mode change is processed
- **AND** subsequent partial or final transcript events SHALL reset the timer to ~60 seconds from the moment they arrive
- **AND** if no transcript event arrives for ~60 seconds, the Ear SHALL send `session_end` with reason `timeout` and play the endpoint cue
