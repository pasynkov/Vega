## MODIFIED Requirements

### Requirement: Always-on wake-word detection

The Ear SHALL continuously stream microphone audio through a wake-word detector that emits a `wake_detected` event when any of the configured wake-word candidates is recognized.

The wake-word detector SHALL be accessed only through a `WakeWordDetector` Swift protocol. The implementation behind this protocol SHALL use OpenWakeWord (ONNX). It SHALL load the OpenWakeWord shared front-end (`melspectrogram.onnx`, `embedding_model.onnx`) plus a configurable list of classifier-head model files from the app bundle's `Resources/` directory; no remote download SHALL occur at runtime. The MVP candidate set SHALL be `["Vega"]`, backed by a single project-trained classifier head `Vega.onnx` (produced by the `wake-word-training` capability) that detects the Russian utterance "Вега". The previously bundled placeholder heads `Janet.onnx` and `edna.onnx` SHALL NOT be present in the bundle. No call site outside the implementation type SHALL reference OpenWakeWord or ONNX Runtime APIs directly.

For every chunk of captured audio the detector SHALL run the shared front-end exactly once and then run each candidate classifier head against the resulting embedding. The detector SHALL emit a `wake_detected` event when at least one candidate's per-frame confidence score crosses the user-configurable threshold described in the "Tunable wake-word sensitivity" requirement. The winning candidate name and score SHALL be recorded in the app log on every detection so the user can compare candidates offline.

The Ear SHALL also expose a debug "Trigger test wake" / "Stop listening" menu-bar item that synthesises a `wake_detected` event without going through the keyword detector. This lets the developer drive the rest of the pipeline (capture → Core → Deepgram → recordings) end to end. The menu item's label flips based on whether a session is active.

#### Scenario: Wake word candidate is spoken

- **WHEN** the user speaks the configured wake word ("Вега") within microphone range while the app is `idle`
- **THEN** within 400 ms a `wake_detected` event SHALL be sent to Core over the WebSocket
- **AND** the status item SHALL transition to `listening`
- **AND** the configured wake cue SHALL be played
- **AND** the app log SHALL include the winning candidate name (`Vega`) and confidence score

#### Scenario: Non-wake speech is ignored

- **WHEN** the user speaks for at least 5 seconds without uttering the configured wake word "Вега"
- **THEN** no `wake_detected` event SHALL be emitted
- **AND** no audio frames SHALL be sent to Core

#### Scenario: Confidence below the configured threshold is ignored

- **WHEN** every candidate classifier produces a per-frame score below the user-configured threshold
- **THEN** no `wake_detected` event SHALL be emitted
- **AND** the status item SHALL remain `idle`

#### Scenario: Wake-word engine fails to initialize

- **WHEN** the OpenWakeWord detector fails to initialize (any required bundled ONNX resource — `melspectrogram.onnx`, `embedding_model.onnx`, or `Vega.onnx` — is missing, or ONNX Runtime initialization errors out)
- **THEN** the status item SHALL show `error`
- **AND** the menu SHALL surface a human-readable description of the failure
- **AND** the app SHALL retry initialization no more often than once per 30 seconds
