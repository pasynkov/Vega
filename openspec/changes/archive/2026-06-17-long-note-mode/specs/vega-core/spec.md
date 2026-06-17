## MODIFIED Requirements

### Requirement: Streaming STT session via Deepgram

For each `session_start` received from an Ear, Core SHALL open a streaming WebSocket to Deepgram's `/v1/listen` endpoint configured for the user's language and the session's declared codec (`linear16` in MVP) and sample rate, and SHALL forward audio frames from the Ear to Deepgram until the session ends. Core SHALL connect with the raw `ws` package rather than via the `@deepgram/sdk` client — the official SDK's surface changed incompatibly between major versions and reduced visibility into protocol-level errors.

Core SHALL relay Deepgram's interim transcripts as `partial_transcript` messages to the originating Ear and SHALL relay the final transcript as `final_transcript`. Core SHALL log Deepgram's `UtteranceEnd` event as informational only; the authoritative end-of-utterance signal SHALL be the Ear's local VAD or, as a fallback, Core's own silence detector.

Core SHALL verify the configured `DEEPGRAM_API_KEY` against Deepgram's `/v1/projects` REST endpoint at startup and SHALL log an explicit error if the key is rejected, so a bad key is visible immediately rather than via repeated live-session failures.

Core SHALL run a per-session adaptive silence detector on the incoming PCM with the same calibration semantics as the Ear's and a default 5-second silence window in `regular` mode. When it fires, Core SHALL terminate the session with reason `endpoint` (initiator `core:vad`). A separate "silence cap" timer SHALL terminate sessions where Deepgram has produced no transcript at all for the same window (initiator `core:silence_cap`). Both are fallbacks; the Ear's local VAD usually fires first.

The per-session silence cap milliseconds SHALL be mutable at runtime via an internal API exposed to in-process tool handlers. The default SHALL be 5 seconds. The `long_note` mode SHALL raise the cap to ~60 seconds, measured from the last partial OR final transcript event. The reverse transition SHALL NOT occur in the same session.

The per-session VAD detector SHALL be suppressed when the session enters `long_note` mode, so that it does NOT fire `core:vad` while the user is mid-thought; it MAY continue running for logging purposes. The silence cap timer SHALL remain active in `long_note` mode and SHALL act as the Core-side safety backstop alongside the Ear's local safety timer.

Every session termination SHALL log an explicit `initiator` label (one of `ear:user`, `ear:vad`, `ear:timeout`, `core:vad`, `core:silence_cap`, `core:safety_timeout`, `core:deepgram_error`, `core:ear_disconnect`, `core:shutdown`, `core:long_note_end`) so the cause of every end-of-session event is unambiguous from a single log line. The `core:long_note_end` value SHALL be used when termination is initiated by the `endLongNoteMode` tool.

#### Scenario: Happy-path session

- **WHEN** Core receives `session_start` followed by audio frames and the Ear's local VAD ends the session with `session_end` reason `vad`
- **THEN** Core SHALL close the Deepgram connection
- **AND** SHALL send `session_end` with reason `timeout` (mapping from `vad`) back to the Ear with initiator `ear:vad`
- **AND** SHALL persist the consolidated transcript and audio

#### Scenario: Deepgram returns an error mid-session

- **WHEN** the Deepgram connection errors or closes unexpectedly while a session is active
- **THEN** Core SHALL send `session_end` with reason `stt_error` and a human-readable detail string to the Ear
- **AND** SHALL persist whatever interim transcripts were received up to that point
- **AND** SHALL NOT retry the same session automatically

#### Scenario: Safety timeout on long session

- **WHEN** a session has been active for the configured `SESSION_TIMEOUT_MS` without ending
- **THEN** Core SHALL close the Deepgram connection
- **AND** SHALL send `session_end` with reason `timeout` to the Ear
- **AND** SHALL persist what was captured so far

#### Scenario: Silence cap raised on long-note transition

- **WHEN** the `enableLongNoteMode` tool runs successfully for an active session
- **THEN** Core SHALL set the session's silence cap to ~60 seconds
- **AND** SHALL suppress the per-session VAD-driven `core:vad` termination for the remainder of the session
- **AND** SHALL send `session_mode` of `long_note` and `play_cue` of `ack_continue` to the Ear

#### Scenario: Long-note end initiated by tool

- **WHEN** the `endLongNoteMode(cleanText)` tool runs successfully
- **THEN** Core SHALL terminate the session with reason `endpoint` and initiator `core:long_note_end`
- **AND** the cleaned text SHALL be persisted as a note artifact
- **AND** Core SHALL send the standard endpoint cue and `session_end` to the Ear

#### Scenario: Long-note silence cap as safety backstop

- **WHEN** a long-note session is active and no partial or final transcript arrives for ~60 seconds
- **THEN** Core's silence cap SHALL fire and terminate the session with initiator `core:silence_cap`
- **AND** any transcript accumulated SHALL be persisted via the same path used by `endLongNoteMode`, or by a fallback persister if the tool path is unreachable
