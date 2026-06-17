## MODIFIED Requirements

### Requirement: Always-on wake-word detection

The Ear SHALL continuously stream microphone audio through a wake-word detector that emits a `wake_detected` event when any of the configured wake-word candidates is recognized.

The wake-word detector SHALL be accessed only through a `WakeWordDetector` Swift protocol. The implementation behind this protocol SHALL use OpenWakeWord (ONNX). It SHALL load the OpenWakeWord shared front-end (`melspectrogram.onnx`, `embedding_model.onnx`) plus a configurable list of classifier-head model files from the app bundle's `Resources/` directory; no remote download SHALL occur at runtime. The MVP candidate set SHALL be `["Janet", "edna"]`, both as 200 KB community-trained ONNX classifier heads. No call site outside the implementation type SHALL reference OpenWakeWord or ONNX Runtime APIs directly.

For every chunk of captured audio the detector SHALL run the shared front-end exactly once and then run each candidate classifier head against the resulting embedding. The detector SHALL emit a `wake_detected` event when at least one candidate's per-frame confidence score crosses the user-configurable threshold described in the "Tunable wake-word sensitivity" requirement. The winning candidate name and score SHALL be recorded in the app log on every detection so the user can compare candidates offline.

The Ear SHALL also expose a debug "Trigger test wake" / "Stop listening" menu-bar item that synthesises a `wake_detected` event without going through the keyword detector. This lets the developer drive the rest of the pipeline (capture → Core → Deepgram → recordings) end to end. The menu item's label flips based on whether a session is active.

#### Scenario: Wake word candidate is spoken

- **WHEN** the user speaks one of the configured candidate wake words ("Janet" or "Edna") within microphone range while the app is `idle`
- **THEN** within 400 ms a `wake_detected` event SHALL be sent to Core over the WebSocket
- **AND** the status item SHALL transition to `listening`
- **AND** the configured wake cue SHALL be played
- **AND** the app log SHALL include the winning candidate name and confidence score

#### Scenario: Non-wake speech is ignored

- **WHEN** the user speaks for at least 5 seconds without uttering any configured candidate wake word
- **THEN** no `wake_detected` event SHALL be emitted
- **AND** no audio frames SHALL be sent to Core

#### Scenario: Confidence below the configured threshold is ignored

- **WHEN** every candidate classifier produces a per-frame score below the user-configured threshold
- **THEN** no `wake_detected` event SHALL be emitted
- **AND** the status item SHALL remain `idle`

#### Scenario: Wake-word engine fails to initialize

- **WHEN** the OpenWakeWord detector fails to initialize (any required bundled ONNX resource is missing, or ONNX Runtime initialization errors out)
- **THEN** the status item SHALL show `error`
- **AND** the menu SHALL surface a human-readable description of the failure
- **AND** the app SHALL retry initialization no more often than once per 30 seconds

## ADDED Requirements

### Requirement: Tunable wake-word sensitivity

The Ear SHALL allow the user to configure the wake-word confidence threshold without editing source. The threshold SHALL be persisted in `Application Support/Vega/preferences.json` alongside the chosen microphone device and SHALL be restored on next launch. The default threshold SHALL be `0.5`. Valid values SHALL be in the open interval `(0.0, 1.0)`. The same threshold SHALL apply uniformly to every configured candidate classifier.

The status-item menu SHALL expose a "Wake sensitivity" submenu with at least the presets `Low (0.3)`, `Default (0.5)`, `High (0.7)`, and `Very High (0.85)`. Selecting a preset SHALL update the threshold immediately for subsequent wake-detection decisions without requiring an app restart.

#### Scenario: User raises sensitivity to "High"

- **WHEN** the user selects `High (0.7)` from the "Wake sensitivity" submenu while the app is `idle`
- **THEN** the threshold SHALL be persisted to `preferences.json`
- **AND** subsequent wake-word evaluations SHALL require a model score of at least 0.7 to emit `wake_detected`
- **AND** no app restart SHALL be required

#### Scenario: Threshold restored on relaunch

- **WHEN** the user previously set the wake sensitivity to `Very High (0.85)` and quits the app
- **AND** the user relaunches the app
- **THEN** the detector SHALL initialize with threshold 0.85
- **AND** the "Wake sensitivity" submenu SHALL show `Very High (0.85)` as the active option

#### Scenario: Missing or invalid threshold value

- **WHEN** the app launches and `preferences.json` is missing, unreadable, or contains a wake-threshold value outside `(0.0, 1.0)`
- **THEN** the detector SHALL initialize with the default threshold 0.5
- **AND** the next successful preference write SHALL persist the default
