# vega-core Specification

## Purpose

The Vega Core daemon — a NestJS process running on the user's machine that accepts WebSocket connections from any Ear client, relays captured audio to Deepgram's streaming STT, runs server-side endpointing as a backup to the Ear's local VAD, and persists each session as a directory of audio + transcript + metadata under `recordings/`.

## Requirements

### Requirement: Local WebSocket server for Ear clients

Core SHALL expose a WebSocket endpoint on `127.0.0.1:7777/ear` that accepts connections from any Ear client implementing the `ear-protocol` schema.

The endpoint SHALL bind to loopback only by default and SHALL NOT listen on any non-loopback interface unless explicitly configured to do so in a future change. Core SHALL accept multiple concurrent Ear connections; in the MVP only one is exercised.

#### Scenario: Ear connects and registers

- **WHEN** an Ear opens a WebSocket connection and sends a valid `register` message
- **THEN** Core SHALL store the `deviceId`, `deviceName`, and `capabilities` in an in-process registry
- **AND** SHALL respond with an `ack` message including the `deviceId`

#### Scenario: Malformed message is received

- **WHEN** Core receives a payload that does not validate against the `ear-protocol` schema
- **THEN** Core SHALL log the malformed payload at warning level
- **AND** SHALL NOT crash the connection
- **AND** SHALL NOT propagate the bad payload to downstream consumers

### Requirement: Wake-event handling

Core SHALL accept `wake_detected` events from registered Ears and SHALL determine whether the emitting Ear is allowed to proceed into a capture session.

In the MVP the policy SHALL always be "proceed" — Core SHALL not yet implement multi-Ear scoring. The wake-handling code SHALL be structured so that a future change can introduce a coordination policy without changing the protocol surface.

#### Scenario: Single-Ear wake

- **WHEN** Core receives a `wake_detected` event from a registered Ear
- **THEN** Core SHALL respond with a `wake_ack` message of action `proceed`
- **AND** SHALL prepare to receive a `session_start` from that Ear

### Requirement: Streaming STT session via Deepgram

For each `session_start` received from an Ear, Core SHALL open a streaming WebSocket to Deepgram's `/v1/listen` endpoint configured for the user's language and the session's declared codec (`linear16` in MVP) and sample rate, and SHALL forward audio frames from the Ear to Deepgram until the session ends. Core SHALL connect with the raw `ws` package rather than via the `@deepgram/sdk` client — the official SDK's surface changed incompatibly between major versions and reduced visibility into protocol-level errors.

Core SHALL relay Deepgram's interim transcripts as `partial_transcript` messages to the originating Ear and SHALL relay the final transcript as `final_transcript`. Core SHALL log Deepgram's `UtteranceEnd` event as informational only; the authoritative end-of-utterance signal SHALL be the Ear's local VAD or, as a fallback, Core's own silence detector.

Core SHALL verify the configured `DEEPGRAM_API_KEY` against Deepgram's `/v1/projects` REST endpoint at startup and SHALL log an explicit error if the key is rejected, so a bad key is visible immediately rather than via repeated live-session failures.

Core SHALL run a per-session adaptive silence detector on the incoming PCM with the same calibration semantics as the Ear's and a 5-second silence window. When it fires, Core SHALL terminate the session with reason `endpoint` (initiator `core:vad`). A separate "silence cap" timer SHALL terminate sessions where Deepgram has produced no transcript at all for the same window (initiator `core:silence_cap`). Both are fallbacks; the Ear's local VAD usually fires first.

Every session termination SHALL log an explicit `initiator` label (one of `ear:user`, `ear:vad`, `ear:timeout`, `core:vad`, `core:silence_cap`, `core:safety_timeout`, `core:deepgram_error`, `core:ear_disconnect`, `core:shutdown`) so the cause of every end-of-session event is unambiguous from a single log line.

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

### Requirement: Session persistence to repo `recordings/`

For every session that reaches at least one audio frame, Core SHALL write a directory `recordings/<ISO-timestamp>/` containing exactly three files: `audio.ogg`, `transcript.txt`, and `meta.json`.

The `audio.ogg` file SHALL be an OGG container with an OPUS-encoded mono stream produced by Core from the raw PCM frames it received from the Ear. The encoding SHALL be performed via ffmpeg (e.g. `ffmpeg-static`) and SHALL use the session's declared sample rate. The resulting file SHALL satisfy Telegram Bot API's `sendVoice` format requirements without further transcoding.

The `transcript.txt` file SHALL be the UTF-8 final transcript text, or the concatenation of received partials if no final was reached. A trailing newline SHALL be included.

The `meta.json` file SHALL be a JSON object containing at minimum: `sessionId`, `deviceId`, `deviceName`, `userId` (nullable, always `null` in MVP), `startedAt` (ISO-8601), `endedAt` (ISO-8601), `endReason`, `wakeScore` (nullable), `language`, `transcriptConfidence` (nullable), and `sampleRate`.

The base path of `recordings/` SHALL be configurable via environment variable, defaulting to the repo root.

#### Scenario: Successful session is persisted

- **WHEN** a session ends with any reason and at least one audio frame was received
- **THEN** within 2 seconds of `session_end` Core SHALL have written `recordings/<ts>/audio.ogg`, `recordings/<ts>/transcript.txt`, and `recordings/<ts>/meta.json`
- **AND** `meta.json` SHALL include all fields listed above with non-empty values where applicable

#### Scenario: Empty session is not persisted

- **WHEN** Core receives `session_start` followed immediately by `session_end` with no audio frames
- **THEN** no directory SHALL be created under `recordings/`

### Requirement: Configuration via environment variables

Core SHALL read its configuration from environment variables at startup. Required variables: `DEEPGRAM_API_KEY`. Optional variables with defaults: `EAR_WS_HOST` (default `127.0.0.1`), `EAR_WS_PORT` (default `7777`), `RECORDINGS_DIR` (default `<repo-root>/recordings`), `DEEPGRAM_LANGUAGE` (default `ru`), `SESSION_TIMEOUT_MS` (default `30000`), `LOG_LEVEL` (default `debug`).

Secrets SHALL NOT be logged. Configuration sources SHALL be loaded from a `.env` file when present.

#### Scenario: Missing required variable

- **WHEN** Core is launched without `DEEPGRAM_API_KEY` set
- **THEN** Core SHALL exit with a non-zero status and a clear error message naming the missing variable

#### Scenario: All required variables present

- **WHEN** Core is launched with `DEEPGRAM_API_KEY` and any subset of optional variables
- **THEN** Core SHALL bind the WebSocket endpoint and SHALL log its configured values, redacting `DEEPGRAM_API_KEY`

### Requirement: Clean shutdown

Core SHALL exit cleanly within 2 seconds of receiving SIGINT or SIGTERM.

On shutdown Core SHALL terminate every in-flight session (clearing timers, closing Deepgram sockets, persisting captured audio), terminate every connected Ear WebSocket, close the listening server, and release any worker threads spawned by the logging stack so the process actually exits when its event loop drains. Logging output SHALL use a synchronous pretty-print stream rather than a worker-thread transport that would keep the event loop alive past `app.close()`.

A second SIGINT/SIGTERM SHALL force the process to exit immediately with a non-zero status.

#### Scenario: Ctrl+C exits the process

- **WHEN** the operator sends SIGINT to a Core process with an active Ear connection
- **THEN** Core SHALL terminate every in-flight session with initiator `core:shutdown`
- **AND** SHALL close the Ear WebSocket connections and the WS server
- **AND** the process SHALL exit within 2 seconds

### Requirement: Long-note mode silence cap and termination

A session opened under `long_note` mode (Ear sent `session_start` with `mode: "long_note"`) SHALL run with a ~60 second silence cap measured from the last partial OR final transcript, and with the per-session VAD-driven `core:vad` termination suppressed. The Core-side silence cap and the Ear-side safety cap together act as backstops.

A new termination initiator label `core:long_note_end` SHALL be used when the session is terminated by the `end_long_note_mode` tool persisting the long note and closing the session.

The `notes` domain SHALL expose an `enable_long_note_mode` tool that, instead of mutating the active regular session, dispatches an `arm_capture` message to the connected Ear so a fresh long-note session is opened. The original short utterance terminates normally via its own VAD / silence cap.

#### Scenario: long-note session uses the relaxed cap from start

- **WHEN** the Ear sends `session_start` with `mode: "long_note"`
- **THEN** Core SHALL set the session's silence cap to ~60 seconds
- **AND** Core SHALL suppress the per-session VAD-driven `core:vad` termination for the lifetime of the session

#### Scenario: long-note end via tool

- **WHEN** the `end_long_note_mode(cleanText)` tool runs successfully for an active long-note session
- **THEN** Core SHALL persist the note to `output/notes/`
- **AND** Core SHALL terminate the session with reason `endpoint` and initiator `core:long_note_end`
- **AND** Core SHALL send the standard endpoint cue and `session_end` to the Ear
