## MODIFIED Requirements

### Requirement: Streaming STT session via Deepgram

For each `session_start` received from an Ear, Core SHALL open a streaming WebSocket to Deepgram's `/v1/listen` endpoint configured for the user's language and the session's declared codec (`linear16` in MVP) and sample rate, and SHALL forward audio frames from the Ear to Deepgram until the session ends. Core SHALL connect with the raw `ws` package rather than via the `@deepgram/sdk` client — the official SDK's surface changed incompatibly between major versions and reduced visibility into protocol-level errors.

Core SHALL relay Deepgram's interim transcripts as `partial_transcript` messages to the originating Ear and SHALL relay the final transcript as `final_transcript`. Core SHALL log Deepgram's `UtteranceEnd` event as informational only; the authoritative end-of-utterance signal SHALL be the Ear's local VAD or, as a fallback, Core's own silence detector.

Core SHALL verify the configured `DEEPGRAM_API_KEY` against Deepgram's `/v1/projects` REST endpoint at startup and SHALL log an explicit error if the key is rejected, so a bad key is visible immediately rather than via repeated live-session failures, UNLESS the boot-time auth check is suppressed via the `VEGA_DISABLE_BOOT_PING=1` environment variable — in which case the verification SHALL be skipped entirely (no outbound `fetch`, no log). The same flag SHALL also suppress the LLM-side boot checks (`LlmService.verifyAuth` and `LlmService.ping`) so a complete Core boot under the flag produces zero outbound HTTPS traffic. This flag exists to make the e2e test harness deterministic and offline; it SHALL NOT be set in any production deployment.

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

#### Scenario: Boot-time auth check suppressed under the flag

- **WHEN** Core is launched with `VEGA_DISABLE_BOOT_PING=1` in its environment
- **THEN** Core SHALL NOT issue the `GET https://api.deepgram.com/v1/projects` startup `fetch`
- **AND** SHALL NOT issue the `GET https://api.anthropic.com/v1/models` startup `fetch`
- **AND** SHALL NOT invoke the LLM `ping` request even if `llmPingOnBoot` is set
- **AND** SHALL emit no error log claiming the keys are invalid

### Requirement: Configuration via environment variables

Core SHALL read its configuration from environment variables at startup. Required variables: `DEEPGRAM_API_KEY`. Optional variables with defaults: `EAR_WS_HOST` (default `127.0.0.1`), `EAR_WS_PORT` (default `7777`), `RECORDINGS_DIR` (default `<repo-root>/recordings`), `DEEPGRAM_LANGUAGE` (default `ru`), `SESSION_TIMEOUT_MS` (default `30000`), `LOG_LEVEL` (default `debug`), `VEGA_DISABLE_BOOT_PING` (default unset; when set to `1`, suppresses the boot-time Deepgram and LLM auth checks as documented in the Streaming STT session requirement).

#### Scenario: Missing required variable

- **WHEN** Core is launched without `DEEPGRAM_API_KEY` set
- **THEN** Core SHALL exit with a non-zero status
- **AND** SHALL print a human-readable message naming the missing variable

#### Scenario: Optional variables fall back to defaults

- **WHEN** Core is launched with `DEEPGRAM_API_KEY` and any subset of optional variables
- **THEN** Core SHALL bind the WebSocket endpoint and SHALL log its configured values, redacting `DEEPGRAM_API_KEY`
- **AND** SHALL apply the documented default for every variable not explicitly set

#### Scenario: Boot-ping suppression flag is opt-in

- **WHEN** Core is launched without `VEGA_DISABLE_BOOT_PING` set in its environment
- **THEN** Core SHALL perform the documented boot-time `verifyAuth` calls to Deepgram and Anthropic
- **AND** SHALL behave as if the flag were explicitly set to `0`
